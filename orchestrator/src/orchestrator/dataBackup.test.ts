import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Données + destination isolées AVANT les imports.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-backup-'));
process.env.YUI_DATA_DIR = path.join(tmp, 'data');
process.env.YUI_BACKUP_DIR = path.join(tmp, 'backups');

import { backupsToPrune, runBackup, sortBackups } from './dataBackup';

async function run(): Promise<void> {
    // Tri et rotation (purs)
    const names = [
        'yui-data-2026-09-01.tar.gz',
        'yui-data-2026-09-06.tar.gz',
        'yui-data-2026-09-03.tar.gz',
        'pas-un-backup.txt',
    ];
    assert.deepStrictEqual(sortBackups(names), [
        'yui-data-2026-09-06.tar.gz',
        'yui-data-2026-09-03.tar.gz',
        'yui-data-2026-09-01.tar.gz',
    ]);
    assert.deepStrictEqual(backupsToPrune(names, 2), [
        'yui-data-2026-09-01.tar.gz',
    ]);
    assert.deepStrictEqual(backupsToPrune(names, 10), []);

    // Archive réelle : config + shared + memoire, state jetable exclu
    fs.mkdirSync(path.join(tmp, 'data', 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'data', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'data', 'state'), { recursive: true });
    fs.writeFileSync(
        path.join(tmp, 'data', 'config', 'scenes.json'),
        '[{"id":"x"}]',
    );
    fs.writeFileSync(path.join(tmp, 'data', 'shared', 'google.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'data', 'state', 'memory.json'), '{"m":1}');
    fs.writeFileSync(path.join(tmp, 'data', 'state', 'timers.json'), '[]');

    const out = await runBackup();
    assert.ok(out && fs.existsSync(out), 'archive créée');

    const { execFileSync } = await import('child_process');
    const listing = execFileSync('tar', ['-tzf', out!]).toString();
    assert.ok(listing.includes('config/scenes.json'), 'scènes dedans');
    assert.ok(listing.includes('shared/google.json'), 'credentials dedans');
    assert.ok(listing.includes('state/memory.json'), 'mémoire dedans');
    assert.ok(!listing.includes('timers.json'), 'state jetable exclu');

    console.log('All dataBackup tests passed');
}

run()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
