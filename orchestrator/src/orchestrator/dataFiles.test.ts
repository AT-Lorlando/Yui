// orchestrator/src/orchestrator/dataFiles.test.ts
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    classifyDataFile,
    listDataFiles,
    readDataFile,
    writeDataFile,
} from './dataFiles';

function run(): void {
    // ── classifyDataFile (by name) ────────────────────────────────────────────
    assert.strictEqual(classifyDataFile('scenes.json'), 'editable');
    assert.strictEqual(classifyDataFile('proactive.json'), 'editable');
    assert.strictEqual(classifyDataFile('samsung-tv-token.json'), 'secret');
    assert.strictEqual(classifyDataFile('fcm-token.json'), 'secret');
    assert.strictEqual(
        classifyDataFile('firebase-service-account.json'),
        'secret',
    );
    assert.strictEqual(classifyDataFile('story-index.json'), 'state');
    assert.strictEqual(classifyDataFile('amp-state.json'), 'state');
    const saKey = '{ "type": "service_account", "private_key": "-----BEGIN" }';
    assert.strictEqual(
        classifyDataFile('yuiproject-55825-abc.json', saKey),
        'secret',
    );
    assert.strictEqual(
        classifyDataFile('google.json', '{ "refresh_token": "x" }'),
        'secret',
    );
    assert.strictEqual(
        classifyDataFile('scenes.json', '[{"id":"x"}]'),
        'editable',
    );

    // ── list / read / write against a temp data root via YUI_DATA_DIR ─────────
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-data-'));
    const prev = process.env.YUI_DATA_DIR;
    process.env.YUI_DATA_DIR = root;
    try {
        fs.mkdirSync(path.join(root, 'config'), { recursive: true });
        fs.mkdirSync(path.join(root, 'state'), { recursive: true });
        fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
        fs.writeFileSync(path.join(root, 'config', 'scenes.json'), '[]');
        fs.writeFileSync(path.join(root, 'state', 'amp-state.json'), '{}');
        fs.writeFileSync(
            path.join(root, 'shared', 'firebase-service-account.json'),
            '{"private_key":"x"}',
        );

        const files = listDataFiles();
        const byName = Object.fromEntries(files.map((f) => [f.name, f]));
        assert.strictEqual(byName['scenes.json'].category, 'config');
        assert.strictEqual(byName['scenes.json'].kind, 'editable');
        assert.strictEqual(byName['amp-state.json'].category, 'state');
        assert.strictEqual(byName['amp-state.json'].kind, 'state');
        assert.strictEqual(
            byName['firebase-service-account.json'].category,
            'shared',
        );

        assert.strictEqual(readDataFile('scenes.json'), '[]');
        assert.throws(() => readDataFile('firebase-service-account.json'));
        writeDataFile('scenes.json', '[{"id":"a"}]');
        assert.strictEqual(readDataFile('scenes.json'), '[{"id":"a"}]');
        assert.throws(() => writeDataFile('amp-state.json', '{}'));
        assert.throws(() => writeDataFile('scenes.json', 'not json'));
        assert.throws(() => readDataFile('../secret.json'));
    } finally {
        if (prev === undefined) delete process.env.YUI_DATA_DIR;
        else process.env.YUI_DATA_DIR = prev;
        fs.rmSync(root, { recursive: true, force: true });
    }

    console.log('All dataFiles tests passed');
}

run();
