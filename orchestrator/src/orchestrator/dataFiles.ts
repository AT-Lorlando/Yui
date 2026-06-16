// orchestrator/src/orchestrator/dataFiles.ts
//
// Raw editor for data/*.json with guardrails (see spec 2026-06-15, data
// addendum). Most files in data/ are NOT hand-editable config:
//   - secret: tokens / service-account keys / OAuth creds → never exposed, never written
//   - state:  runtime state written by the system (story index, amp state, dedup) → read-only
//   - editable: the rest (scenes, proactive, chromecast-content, …) → read + write
// Classification is by filename AND by content (catches random-named service
// account keys like yuiproject-55825-*.json via their private_key field).
import * as fs from 'fs';
import * as path from 'path';

export type DataKind = 'secret' | 'state' | 'editable';

const SECRET_NAME_RE =
    /(token|secret|credential|service-account|firebase|fcm)/i;
const SECRET_CONTENT_RE =
    /"(private_key|client_secret|refresh_token|access_token|client_email)"\s*:/;

// Runtime state written by the system — viewable but not editable by hand.
const STATE_FILES = new Set([
    'story-index.json',
    'amp-state.json',
    'proactive-dedup.json',
    'proactive-digest.json',
    'automation-history.json',
]);

/** Classify a data file by name and (optionally) its content. Pure. */
export function classifyDataFile(name: string, content?: string): DataKind {
    if (SECRET_NAME_RE.test(name)) return 'secret';
    if (content && SECRET_CONTENT_RE.test(content)) return 'secret';
    if (STATE_FILES.has(name)) return 'state';
    return 'editable';
}

import { dataPath, dataRoot, type DataCategory } from '@yui/shared';

export interface DataFileInfo {
    name: string;
    size: number;
    kind: DataKind;
    category: DataCategory;
}

const CATEGORIES: DataCategory[] = ['shared', 'config', 'state'];

/** Reject anything that isn't a bare <name>.json basename. */
function resolveDataFile(name: string): string {
    if (!name.endsWith('.json'))
        throw new Error('Only .json files are allowed');
    if (name.includes('/') || name.includes('\\') || name.includes('..'))
        throw new Error('Invalid file name');
    return dataPath(name);
}

export function listDataFiles(): DataFileInfo[] {
    const root = dataRoot();
    const out: DataFileInfo[] = [];
    for (const category of CATEGORIES) {
        const dir = path.join(root, category);
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json')) continue;
            const full = path.join(dir, name);
            const stat = fs.statSync(full);
            let content: string | undefined;
            try {
                content = fs.readFileSync(full, 'utf-8');
            } catch {
                content = undefined;
            }
            out.push({
                name,
                size: stat.size,
                kind: classifyDataFile(name, content),
                category,
            });
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a file's content. Secrets are refused. */
export function readDataFile(name: string): string {
    const resolved = resolveDataFile(name);
    if (!fs.existsSync(resolved)) throw new Error('File not found');
    const content = fs.readFileSync(resolved, 'utf-8');
    if (classifyDataFile(name, content) === 'secret') {
        throw new Error('This file is a secret and cannot be viewed');
    }
    return content;
}

/** Overwrite an editable file. Validates JSON; refuses secret/state files. */
export function writeDataFile(name: string, content: string): void {
    const resolved = resolveDataFile(name);
    let existing: string | undefined;
    try {
        existing = fs.readFileSync(resolved, 'utf-8');
    } catch {
        existing = undefined;
    }
    const kind = classifyDataFile(name, existing ?? content);
    if (kind === 'secret') throw new Error('Secret files cannot be edited');
    if (kind === 'state') {
        throw new Error('This file is runtime state and is read-only');
    }
    try {
        JSON.parse(content);
    } catch {
        throw new Error('Content is not valid JSON');
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
}
