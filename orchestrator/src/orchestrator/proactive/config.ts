import * as fs from 'fs';
import * as path from 'path';
import type { ProactiveConfig } from './types';
import Logger from '../../logger';
import { dataPath } from '@yui/shared';

const CONFIG_FILE = dataPath('proactive.json');

/** System prompt used to turn a watcher's facts into one short spoken line. */
export const DEFAULT_PHRASE_PROMPT =
    "Tu es Yui, l'assistante de Jérémy. Reformule ce fait en une phrase orale courte et naturelle, en français, sans aucun markdown. Si ce n'est pas digne d'être signalé, réponds exactement RIEN. Si un message « Déjà signalé récemment » t'est fourni, ne reformule la nouvelle situation que si elle apporte une information vraiment nouvelle par rapport à ce qui a déjà été dit ; sinon réponds exactement RIEN.";
/** System prompt used to summarise the daily digest. */
export const DEFAULT_DIGEST_PROMPT =
    'Tu es Yui. Résume ces points en un court message oral en français, sans markdown, en une ou deux phrases.';

export const DEFAULT_CONFIG: ProactiveConfig = {
    enabled: false,
    chattiness: 'normal',
    quietHours: { start: '23:00', end: '07:00' },
    digestTime: '07:00',
    defaultCooldownMin: 60,
    automationGuardWindowMin: 60,
    whitelist: [],
    prompts: { phrase: DEFAULT_PHRASE_PROMPT, digest: DEFAULT_DIGEST_PROMPT },
    // Livraisons actif par défaut (dès que la proactivité l'est) — la requête
    // Gmail par défaut vit dans le watcher, surchargable ici via `query`.
    deliveries: { pollMinutes: 30 },
};

export function mergeConfig(raw: unknown): ProactiveConfig {
    if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_CONFIG, enabled: false };
    }
    return { ...DEFAULT_CONFIG, ...(raw as Partial<ProactiveConfig>) };
}

/**
 * Anciennes briques `mail-important` + `mail-concierge` → connecteur `mail`.
 * Pur et idempotent : appliqué à chaque lecture, le fichier n'est pas réécrit
 * (une config de prod reste valide telle quelle).
 */
export function migrateBrickIds(cfg: ProactiveConfig): ProactiveConfig {
    const b = { ...(cfg.bricks ?? {}) };
    const legacyMail = b['mail-important'];
    const legacyTriage = b['mail-concierge'];
    if (!legacyMail && !legacyTriage) return cfg;
    const settings: Record<string, unknown> = {
        ...(legacyMail?.settings ?? {}),
        ...(b.mail?.settings ?? {}),
    };
    if (legacyTriage?.enabled !== undefined && settings.triage === undefined) {
        settings.triage = legacyTriage.enabled;
    }
    if (
        cfg.concierge?.pollMinutes !== undefined &&
        settings.pollMinutes === undefined
    ) {
        settings.pollMinutes = cfg.concierge.pollMinutes;
    }
    b.mail = {
        ...(b.mail ?? {}),
        ...(legacyMail?.enabled !== undefined && b.mail?.enabled === undefined
            ? { enabled: legacyMail.enabled }
            : {}),
        settings,
    };
    delete b['mail-important'];
    delete b['mail-concierge'];
    return { ...cfg, bricks: b };
}

export function loadConfig(): ProactiveConfig {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
        return migrateBrickIds(
            mergeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))),
        );
    } catch (err) {
        Logger.warn(`proactive: config invalide — ${err}`);
        return { ...DEFAULT_CONFIG, enabled: false };
    }
}

const CHATTINESS = ['discret', 'normal', 'bavard'];

function validTime(s: unknown): boolean {
    if (typeof s !== 'string') return false;
    const m = /^(\d{2}):(\d{2})$/.exec(s);
    return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

/** Validate a (partial) proactive config patch. Returns errors (empty = ok). */
export function validateConfig(raw: Partial<ProactiveConfig>): string[] {
    const e: string[] = [];
    const o = raw ?? {};
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
        e.push('enabled doit être un booléen');
    if (o.chattiness !== undefined && !CHATTINESS.includes(o.chattiness))
        e.push(`chattiness doit être parmi ${CHATTINESS.join(', ')}`);
    if (
        o.quietHours !== undefined &&
        (!validTime(o.quietHours?.start) || !validTime(o.quietHours?.end))
    )
        e.push('quietHours.start/end doivent être au format HH:MM');
    if (o.digestTime !== undefined && !validTime(o.digestTime))
        e.push('digestTime doit être au format HH:MM');
    const nonNeg = (v: unknown, name: string) => {
        if (v !== undefined && (typeof v !== 'number' || v < 0))
            e.push(`${name} doit être un nombre >= 0`);
    };
    nonNeg(o.defaultCooldownMin, 'defaultCooldownMin');
    nonNeg(o.automationGuardWindowMin, 'automationGuardWindowMin');
    nonNeg(o.budgetPerDay, 'budgetPerDay');
    if (
        o.bricks !== undefined &&
        (typeof o.bricks !== 'object' ||
            o.bricks === null ||
            Array.isArray(o.bricks))
    )
        e.push('bricks doit être un objet { id: { enabled, settings } }');
    if (o.whitelist !== undefined && !Array.isArray(o.whitelist))
        e.push('whitelist doit être une liste');
    if (o.prompts !== undefined) {
        if (typeof o.prompts !== 'object' || o.prompts === null) {
            e.push('prompts doit être un objet');
        } else {
            for (const k of ['phrase', 'digest'] as const) {
                const v = (o.prompts as Record<string, unknown>)[k];
                if (v !== undefined && typeof v !== 'string')
                    e.push(`prompts.${k} doit être une chaîne`);
            }
        }
    }
    return e;
}

/**
 * Validate a patch, merge it onto the persisted config (preserving extra
 * watcher keys), write it back, and return the result. Throws on invalid input.
 */
export function saveConfig(
    patch: Partial<ProactiveConfig>,
    opts?: { file?: string },
): ProactiveConfig {
    const errors = validateConfig(patch);
    if (errors.length) throw new Error(errors.join('; '));

    const file = opts?.file ?? CONFIG_FILE;
    let current: ProactiveConfig;
    try {
        current = fs.existsSync(file)
            ? mergeConfig(JSON.parse(fs.readFileSync(file, 'utf-8')))
            : { ...DEFAULT_CONFIG };
    } catch {
        current = { ...DEFAULT_CONFIG };
    }
    const next = { ...current, ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return next;
}
