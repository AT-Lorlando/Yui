import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import type { AnimationEffect, FloatingConfig } from './types';

/**
 * Bibliothèque d'effets lumineux — entités à part entière, créées et
 * prévisualisées sur la page /effects de l'app, puis simplement RÉFÉRENCÉES
 * par les scènes (`{ effectId, target }`) ou les bindings (`_effect_start`).
 *
 * Un effet est défini SANS cible : la pièce/lampe est choisie à l'usage.
 * Deux sortes :
 *  - `intro`    : timeline de steps (sweep/flash/pulse/fade), jouée une fois ;
 *  - `floating` : dérive continue de couleurs (palette, vitesse, stagger…).
 *
 * Fichier : data/config/effects.json (config d'instance, non versionnée,
 * comme automations). Des effets de départ sont semés à la première lecture.
 */

export interface LightEffect {
    id: string;
    name: string;
    kind: 'intro' | 'floating';
    /** intro : steps de la timeline. `target` optionnel → cible de l'usage. */
    steps?: AnimationEffect[];
    /** floating */
    palette?: string[];
    speedSec?: number;
    staggerSec?: number;
    speedJitter?: number;
    brightness?: number;
    createdAt: number;
}

/** Références persistées dans une scène (à la place de la config inline). */
export interface IntroRef {
    effectId: string;
    target?: string;
}
export interface FloatingRef {
    effectId: string;
    target: string;
    brightness?: number;
}

const FILE = () => dataPath('effects.json');

const SEEDS: Omit<LightEffect, 'createdAt'>[] = [
    {
        id: 'aurora',
        name: 'Aurora',
        kind: 'floating',
        palette: ['#0b3d2e', '#1b7f5c', '#2ec4b6', '#3a0ca3', '#4361ee'],
        speedSec: 90,
        staggerSec: 12,
        speedJitter: 0.25,
        brightness: 45,
    },
    {
        id: 'braise',
        name: 'Braise',
        kind: 'floating',
        palette: ['#7f1d1d', '#c2410c', '#f59e0b', '#92400e'],
        speedSec: 45,
        staggerSec: 6,
        speedJitter: 0.35,
        brightness: 35,
    },
    {
        id: 'ocean',
        name: 'Océan',
        kind: 'floating',
        palette: ['#0c4a6e', '#0369a1', '#06b6d4', '#155e75'],
        speedSec: 70,
        staggerSec: 9,
        speedJitter: 0.2,
        brightness: 40,
    },
    {
        id: 'vague-verte',
        name: 'Vague verte',
        kind: 'intro',
        steps: [
            {
                type: 'sweep',
                target: '',
                colors: ['#00ff88', '#0066ff'],
                staggerMs: 150,
                transitionMs: 400,
            },
        ],
    },
];

function load(): LightEffect[] {
    try {
        if (!fs.existsSync(FILE())) {
            const now = Date.now();
            const seeded = SEEDS.map((s) => ({ ...s, createdAt: now }));
            save(seeded);
            return seeded;
        }
        return JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as LightEffect[];
    } catch (e) {
        Logger.warn(`effects: fichier illisible — ${e}`);
        return [];
    }
}

function save(effects: LightEffect[]): void {
    const dir = path.dirname(FILE());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(effects, null, 2));
}

export function listEffects(): LightEffect[] {
    return load();
}

export function getEffect(id: string): LightEffect | undefined {
    return load().find((e) => e.id === id);
}

export function validateEffect(input: Partial<LightEffect>): string[] {
    const errors: string[] = [];
    if (!input.name?.trim()) errors.push('name requis');
    if (input.kind !== 'intro' && input.kind !== 'floating') {
        errors.push('kind doit être intro ou floating');
    }
    if (input.kind === 'floating') {
        if (!Array.isArray(input.palette) || input.palette.length < 2) {
            errors.push('palette : au moins 2 couleurs');
        }
        if (typeof input.speedSec !== 'number' || input.speedSec <= 0) {
            errors.push('speedSec doit être un nombre > 0');
        }
    }
    if (input.kind === 'intro') {
        if (!Array.isArray(input.steps) || !input.steps.length) {
            errors.push('steps : au moins un step');
        }
    }
    return errors;
}

export function upsertEffect(
    input: Partial<LightEffect> & { id?: string },
): LightEffect {
    const errors = validateEffect(input);
    if (errors.length) throw new Error(errors.join('; '));
    const effects = load();
    const id =
        input.id ||
        input
            .name!.toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') ||
        `effet-${Date.now().toString(36)}`;
    const existing = effects.find((e) => e.id === id);
    const effect: LightEffect = {
        id,
        name: input.name!.trim(),
        kind: input.kind!,
        steps: input.kind === 'intro' ? input.steps : undefined,
        palette: input.kind === 'floating' ? input.palette : undefined,
        speedSec: input.kind === 'floating' ? input.speedSec : undefined,
        staggerSec: input.staggerSec,
        speedJitter: input.speedJitter,
        brightness: input.brightness,
        createdAt: existing?.createdAt ?? Date.now(),
    };
    const next = existing
        ? effects.map((e) => (e.id === id ? effect : e))
        : [...effects, effect];
    save(next);
    return effect;
}

export function deleteEffect(id: string): boolean {
    const effects = load();
    const next = effects.filter((e) => e.id !== id);
    if (next.length === effects.length) return false;
    save(next);
    return true;
}

// ── Résolution des références de scène ─────────────────────────────────────

function isRef(v: unknown): v is { effectId: string } {
    return (
        !!v &&
        typeof v === 'object' &&
        typeof (v as { effectId?: unknown }).effectId === 'string'
    );
}

/**
 * intro de scène → timeline concrète. Accepte l'ancienne forme inline
 * (AnimationEffect[]) et la référence `{ effectId, target }` ; les steps
 * sans cible héritent de la cible de l'usage.
 */
export function resolveIntro(
    intro: AnimationEffect[] | IntroRef | undefined,
    fallbackTarget?: string,
): AnimationEffect[] {
    if (!intro) return [];
    if (Array.isArray(intro)) return intro;
    if (!isRef(intro)) return [];
    const effect = getEffect(intro.effectId);
    if (!effect || effect.kind !== 'intro' || !effect.steps) {
        Logger.warn(`effects: intro "${intro.effectId}" introuvable`);
        return [];
    }
    const target = intro.target ?? fallbackTarget;
    return effect.steps.map((s) => ({
        ...s,
        target: s.target || target || '',
    }));
}

/** floating de scène → config concrète (inline ou `{ effectId, target }`). */
export function resolveFloating(
    floating: FloatingConfig | FloatingRef | undefined,
): FloatingConfig | null {
    if (!floating) return null;
    if (!isRef(floating)) return floating as FloatingConfig;
    const effect = getEffect(floating.effectId);
    if (!effect || effect.kind !== 'floating' || !effect.palette) {
        Logger.warn(`effects: floating "${floating.effectId}" introuvable`);
        return null;
    }
    return {
        engine: 'software',
        target: floating.target,
        palette: effect.palette,
        speedSec: effect.speedSec ?? 60,
        staggerSec: effect.staggerSec,
        speedJitter: effect.speedJitter,
        brightness: floating.brightness ?? effect.brightness,
    };
}
