// orchestrator/src/orchestrator/dataMigration.ts
//
// One-time, idempotent relocation of the flat data/ layout into the
// shared/ config/ state/ subfolders (see spec 2026-06-16-data-dir-split-design).
// Runs at boot from bootstrap.ts, before any reader. Safe to run repeatedly.
// The Python-owned debug dirs (audio-debug/voice-debug) and the top-level
// stories/ dir are intentionally left alone.
import * as fs from 'fs';
import * as path from 'path';
import { categoryOf, dataRoot, type DataCategory } from '@yui/shared';

const SUBDIRS = new Set<string>(['shared', 'config', 'state']);
const SECRET_CONTENT_RE =
    /"(private_key|client_secret|refresh_token|access_token|client_email)"\s*:/;

/** Move flat data/ files into their category folder. Idempotent. */
export function migrateDataLayout(opts?: { root?: string }): void {
    const root = opts?.root ?? dataRoot();
    if (!fs.existsSync(root)) return;

    for (const cat of ['shared', 'config', 'state'] as DataCategory[]) {
        fs.mkdirSync(path.join(root, cat), { recursive: true });
    }

    for (const entry of fs.readdirSync(root)) {
        if (SUBDIRS.has(entry)) continue; // already organized

        const full = path.join(root, entry);
        const stat = fs.statSync(full);

        // Junk backup → delete.
        if (entry === 'story-index.json.pollués.bak') {
            fs.rmSync(full, { force: true });
            continue;
        }

        // Only relocate top-level *.json files; leave dirs and other files
        // (audio-debug/, voice-debug/, etc.) where they are.
        if (stat.isDirectory() || !entry.endsWith('.json')) continue;

        let cat = categoryOf(entry);
        // Upgrade a config-defaulted file to shared if its content is a
        // credential (catches dynamically-named GCP service accounts).
        if (cat === 'config') {
            try {
                if (SECRET_CONTENT_RE.test(fs.readFileSync(full, 'utf-8')))
                    cat = 'shared';
            } catch {
                /* unreadable — leave as config */
            }
        }

        const dest = path.join(root, cat, entry);
        if (fs.existsSync(dest)) continue; // already there — don't clobber
        fs.renameSync(full, dest);
    }
}
