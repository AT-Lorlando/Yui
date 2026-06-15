import * as fs from 'fs';
import * as path from 'path';
import type { ProactiveConfig } from './types';
import Logger from '../../logger';

const CONFIG_FILE = path.resolve(process.cwd(), 'data/proactive.json');

/** System prompt used to turn a watcher's facts into one short spoken line. */
export const DEFAULT_PHRASE_PROMPT =
    "Tu es Yui, l'assistante de Jérémy. Reformule ce fait en une phrase orale courte et naturelle, en français, sans aucun markdown. Si ce n'est pas digne d'être signalé, réponds exactement RIEN.";
/** System prompt used to summarise the daily digest. */
export const DEFAULT_DIGEST_PROMPT =
    'Tu es Yui. Résume ces points en un court message oral en français, sans markdown, en une ou deux phrases.';

export const DEFAULT_CONFIG: ProactiveConfig = {
    enabled: false,
    chattiness: 'normal',
    quietHours: { start: '23:00', end: '07:00' },
    digestTime: '07:00',
    defaultCooldownMin: 30,
    automationGuardWindowMin: 60,
    whitelist: [],
    prompts: { phrase: DEFAULT_PHRASE_PROMPT, digest: DEFAULT_DIGEST_PROMPT },
};

export function mergeConfig(raw: unknown): ProactiveConfig {
    if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_CONFIG, enabled: false };
    }
    return { ...DEFAULT_CONFIG, ...(raw as Partial<ProactiveConfig>) };
}

export function loadConfig(): ProactiveConfig {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
        return mergeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
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
