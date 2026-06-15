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

export interface DataFileInfo {
    name: string;
    size: number;
    kind: DataKind;
}

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

/** Resolve a caller path within data/, enforce .json and no escape. */
function resolveDataPath(dir: string, file: string): string {
    if (!file.endsWith('.json'))
        throw new Error('Only .json files are allowed');
    const root = path.resolve(dir);
    const resolved = path.resolve(root, file);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Path escapes data/ directory');
    }
    return resolved;
}

export function listDataFiles(opts?: { dir?: string }): DataFileInfo[] {
    const dir = path.resolve(opts?.dir ?? 'data');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((name) => {
            const full = path.join(dir, name);
            const stat = fs.statSync(full);
            // Read content only to classify; secrets are never returned here.
            let content: string | undefined;
            try {
                content = fs.readFileSync(full, 'utf-8');
            } catch {
                content = undefined;
            }
            return {
                name,
                size: stat.size,
                kind: classifyDataFile(name, content),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a file's content. Secrets are refused. */
export function readDataFile(file: string, opts?: { dir?: string }): string {
    const dir = opts?.dir ?? 'data';
    const resolved = resolveDataPath(dir, file);
    if (!fs.existsSync(resolved)) throw new Error('File not found');
    const content = fs.readFileSync(resolved, 'utf-8');
    if (classifyDataFile(path.basename(file), content) === 'secret') {
        throw new Error('This file is a secret and cannot be viewed');
    }
    return content;
}

/** Overwrite an editable file. Validates JSON; refuses secret/state files. */
export function writeDataFile(
    file: string,
    content: string,
    opts?: { dir?: string },
): void {
    const dir = opts?.dir ?? 'data';
    const resolved = resolveDataPath(dir, file);

    const name = path.basename(file);
    // Classify against the EXISTING file's content (so a secret can't be
    // unlocked by sending benign content), falling back to the new content.
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
    fs.writeFileSync(resolved, content, 'utf-8');
}
