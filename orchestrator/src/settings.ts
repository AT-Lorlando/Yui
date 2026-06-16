// orchestrator/src/settings.ts
//
// App-editable runtime settings (family C of the .env split — see
// docs/superpowers/specs/2026-06-15-app-editable-config-design.md).
//
// Precedence: data/settings.json (app) > .env > hardcoded default.
// The JSON file is the source of truth once it exists; it is seeded from the
// current env on first boot, so behaviour is unchanged until someone edits it.
import * as fs from 'fs';
import * as path from 'path';
import { dataRoot } from '@yui/shared';

/** Default directory for settings.json — the config category folder. */
function defaultDir(): string {
    return path.join(dataRoot(), 'config');
}

export type LogLevel =
    | 'error'
    | 'warn'
    | 'info'
    | 'verbose'
    | 'debug'
    | 'silly';

export interface Settings {
    llm: { model: string; baseUrl: string | undefined };
    tts: { speed: number; speaker: string };
    logging: { level: LogLevel };
    conversation: { windowSeconds: number };
    deviceState: { refreshMs: number };
    stories: { save: boolean };
    presence: {
        awayTimeoutMin: number;
        arrivalRadiusM: number;
        departureRadiusM: number;
        macPollMs: number;
        arrivalScene: string | null;
        departureScene: string | null;
    };
}

export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type EnvSource = Record<string, string | undefined>;

const LOG_LEVELS: LogLevel[] = [
    'error',
    'warn',
    'info',
    'verbose',
    'debug',
    'silly',
];

const FILENAME = 'settings.json';

function num(v: string | undefined, fallback: number): number {
    const n = v !== undefined ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

/** Build a full Settings object from env values, falling back to defaults. */
export function settingsFromEnv(env: EnvSource): Settings {
    return {
        llm: {
            model: env.LLM_MODEL ?? 'gpt-4o-mini',
            baseUrl: env.LLM_BASE_URL,
        },
        tts: {
            speed: num(env.XTTS_SPEED, 1.0),
            speaker: env.XTTS_SPEAKER ?? 'Lilya Stainthorpe',
        },
        logging: {
            level: (env.LOG_LEVEL as LogLevel) ?? 'info',
        },
        conversation: {
            windowSeconds: num(env.CONVERSATION_WINDOW_S, 20),
        },
        deviceState: {
            refreshMs: num(env.DEVICE_STATE_REFRESH_MS, 30000),
        },
        stories: {
            save: env.SAVE_STORIES === 'true',
        },
        presence: {
            awayTimeoutMin: num(env.PRESENCE_AWAY_TIMEOUT_MIN, 15),
            arrivalRadiusM: num(env.PRESENCE_ARRIVAL_RADIUS_M, 200),
            departureRadiusM: num(env.PRESENCE_DEPARTURE_RADIUS_M, 500),
            macPollMs: num(env.PRESENCE_MAC_POLL_MS, 120000),
            arrivalScene: env.PRESENCE_ARRIVAL_SCENE || null,
            departureScene: env.PRESENCE_DEPARTURE_SCENE || null,
        },
    };
}

/**
 * Write the resolved settings back into an env object (default process.env) so
 * every existing `process.env.*` / env.ts consumer — winston logger, presence,
 * conversations, TTS — sees the same source of truth without per-call wiring.
 * Run this before those modules read their values (see bootstrap.ts).
 */
export function applyToEnv(
    s: Settings,
    env: Record<string, string | undefined> = process.env,
): void {
    env.LLM_MODEL = s.llm.model;
    if (s.llm.baseUrl !== undefined) env.LLM_BASE_URL = s.llm.baseUrl;
    env.XTTS_SPEED = String(s.tts.speed);
    env.XTTS_SPEAKER = s.tts.speaker;
    env.LOG_LEVEL = s.logging.level;
    env.CONVERSATION_WINDOW_S = String(s.conversation.windowSeconds);
    env.DEVICE_STATE_REFRESH_MS = String(s.deviceState.refreshMs);
    env.SAVE_STORIES = String(s.stories.save);
    env.PRESENCE_AWAY_TIMEOUT_MIN = String(s.presence.awayTimeoutMin);
    env.PRESENCE_ARRIVAL_RADIUS_M = String(s.presence.arrivalRadiusM);
    env.PRESENCE_DEPARTURE_RADIUS_M = String(s.presence.departureRadiusM);
    env.PRESENCE_MAC_POLL_MS = String(s.presence.macPollMs);
    if (s.presence.arrivalScene !== null)
        env.PRESENCE_ARRIVAL_SCENE = s.presence.arrivalScene;
    if (s.presence.departureScene !== null)
        env.PRESENCE_DEPARTURE_SCENE = s.presence.departureScene;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Immutable deep-merge: returns a new object with `overlay` winning. */
export function applyOverlay<T>(base: T, overlay: DeepPartial<T>): T {
    const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
    for (const [k, v] of Object.entries(overlay ?? {})) {
        if (v === undefined) continue;
        const cur = (base as any)?.[k];
        out[k] =
            isPlainObject(v) && isPlainObject(cur)
                ? applyOverlay(cur, v as any)
                : v;
    }
    return out;
}

/** Returns a list of human-readable validation errors (empty = valid). */
export function validateOverlay(overlay: DeepPartial<Settings>): string[] {
    const errors: string[] = [];
    const o = overlay ?? {};

    if (o.logging?.level !== undefined && !LOG_LEVELS.includes(o.logging.level))
        errors.push(`logging.level must be one of ${LOG_LEVELS.join(', ')}`);

    const positive = (v: unknown, name: string) => {
        if (v !== undefined && (typeof v !== 'number' || !(v > 0)))
            errors.push(`${name} must be a positive number`);
    };
    const nonNegative = (v: unknown, name: string) => {
        if (v !== undefined && (typeof v !== 'number' || v < 0))
            errors.push(`${name} must be a number >= 0`);
    };

    positive(o.tts?.speed, 'tts.speed');
    positive(o.conversation?.windowSeconds, 'conversation.windowSeconds');
    positive(o.deviceState?.refreshMs, 'deviceState.refreshMs');
    nonNegative(o.presence?.awayTimeoutMin, 'presence.awayTimeoutMin');
    nonNegative(o.presence?.arrivalRadiusM, 'presence.arrivalRadiusM');
    nonNegative(o.presence?.departureRadiusM, 'presence.departureRadiusM');
    nonNegative(o.presence?.macPollMs, 'presence.macPollMs');

    return errors;
}

/**
 * Load settings from `<dir>/settings.json`, resolving precedence json > env.
 * Seeds the file from env on first run (so editing it later is the only way to
 * diverge from .env).
 */
export function loadSettings(opts?: {
    dir?: string;
    env?: EnvSource;
}): Settings {
    const dir = opts?.dir ?? defaultDir();
    const env = opts?.env ?? process.env;
    const file = path.join(dir, FILENAME);
    const fromEnv = settingsFromEnv(env);

    let overlay: DeepPartial<Settings> = {};
    if (fs.existsSync(file)) {
        try {
            overlay = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            overlay = {};
        }
    } else {
        // Seed from env so the file becomes the source of truth going forward.
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(fromEnv, null, 2));
    }
    return applyOverlay(fromEnv, overlay);
}

// ── Module-level cache (used by the orchestrator + REST API) ─────────────────

let current: Settings | null = null;
let activeDir = 'data';
let activeEnv: EnvSource = process.env;

/** Initialise (or re-initialise) the singleton cache from disk. */
export function initSettings(opts?: {
    dir?: string;
    env?: EnvSource;
}): Settings {
    activeDir = opts?.dir ?? defaultDir();
    activeEnv = opts?.env ?? process.env;
    current = loadSettings({ dir: activeDir, env: activeEnv });
    return current;
}

/** Current settings; lazily initialises from process.env + data/ if needed. */
export function getSettings(): Settings {
    if (!current) current = initSettings();
    return current;
}

/** Re-read settings.json into the cache (for fs.watch hot-reload). */
export function reloadSettings(): Settings {
    current = loadSettings({ dir: activeDir, env: activeEnv });
    return current;
}

/**
 * Validate a partial patch, merge it into the persisted overlay, write it back,
 * refresh the cache, and return the resolved settings. Throws on invalid input.
 */
export function updateSettings(patch: DeepPartial<Settings>): Settings {
    const errors = validateOverlay(patch);
    if (errors.length) throw new Error(errors.join('; '));

    const file = path.join(activeDir, FILENAME);
    let overlay: DeepPartial<Settings> = {};
    if (fs.existsSync(file)) {
        try {
            overlay = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            overlay = {};
        }
    }
    const nextOverlay = applyOverlay(overlay as Settings, patch);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(nextOverlay, null, 2));

    current = applyOverlay(settingsFromEnv(activeEnv), nextOverlay);
    return current;
}
