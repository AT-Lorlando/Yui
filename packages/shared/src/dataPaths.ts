// packages/shared/src/dataPaths.ts
//
// One source of truth for where every persisted data file lives. The flat
// data/ layout is split into three lifecycle folders (see spec
// 2026-06-16-data-dir-split-design.md):
//   - shared/ : durable credentials, identical cross-env (never committed)
//   - config/ : hand-edited, versionable config (one file per subsystem)
//   - state/  : runtime state, regenerable / disposable
// Placement here is authoritative; edit-permission stays in
// dataFiles.classifyDataFile.
import * as path from 'path';

export type DataCategory = 'shared' | 'config' | 'state';

/** Authoritative placement registry, keyed by basename. */
const REGISTRY: Record<string, DataCategory> = {
    // shared — durable credentials
    'firebase-service-account.json': 'shared',
    'google.json': 'shared',
    // config — hand-edited, versionable
    'settings.json': 'config',
    'integrations.json': 'config',
    'scenes.json': 'config',
    'automations.json': 'config',
    'irrigation.json': 'config',
    'hue-remotes.json': 'config',
    'proactive.json': 'config',
    'prompts.json': 'config',
    'presence.json': 'config',
    'presence-rules.json': 'config',
    'timer-presets.json': 'config',
    'broadlink-codes.json': 'config',
    // state — runtime, disposable
    'amp-state.json': 'state',
    'timers.json': 'state',
    'story-index.json': 'state',
    'proactive-dedup.json': 'state',
    'proactive-digest.json': 'state',
    'automation-history.json': 'state',
    'chromecast-content.json': 'state',
    'voice-tuning.json': 'state',
    'memory.json': 'state',
    'fcm-token.json': 'state',
    'samsung-tv-token.json': 'state',
    'schedules.json': 'state',
};

/** Base data directory. Override with YUI_DATA_DIR; defaults to <cwd>/data. */
export function dataRoot(): string {
    return process.env.YUI_DATA_DIR ?? path.resolve(process.cwd(), 'data');
}

/**
 * Folder a file belongs in. Registry first; unknown credential-ish basenames
 * fall back to 'shared', everything else to 'config'. Pure (no I/O —
 * dynamically-named service accounts are relocated by migration via content).
 */
export function categoryOf(name: string): DataCategory {
    const known = REGISTRY[name];
    if (known) return known;
    if (/(service-account|firebase|credential)/i.test(name)) return 'shared';
    return 'config';
}

/** Absolute path of a data file under its category folder. */
export function dataPath(name: string): string {
    return path.join(dataRoot(), categoryOf(name), name);
}

/** The three category directories, absolute. */
export function dataCategoryDirs(): Record<DataCategory, string> {
    const root = dataRoot();
    return {
        shared: path.join(root, 'shared'),
        config: path.join(root, 'config'),
        state: path.join(root, 'state'),
    };
}
