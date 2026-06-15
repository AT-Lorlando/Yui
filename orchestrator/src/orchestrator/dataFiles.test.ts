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

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'yui-data-'));
}

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

    // ── classifyDataFile (by content — catches random-named service accounts) ─
    const saKey = '{ "type": "service_account", "private_key": "-----BEGIN" }';
    assert.strictEqual(
        classifyDataFile('yuiproject-55825-abc.json', saKey),
        'secret',
    );
    assert.strictEqual(
        classifyDataFile('google.json', '{ "refresh_token": "x" }'),
        'secret',
    );
    // benign content stays editable
    assert.strictEqual(
        classifyDataFile('scenes.json', '[{"id":"x"}]'),
        'editable',
    );

    // ── list / read / write against a temp data dir ───────────────────────────
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'scenes.json'), '[{"id":"a"}]');
    fs.writeFileSync(path.join(dir, 'amp-state.json'), '{"marantz_amp":"off"}');
    fs.writeFileSync(
        path.join(dir, 'creds.json'),
        '{"private_key":"-----BEGIN"}',
    );

    const list = listDataFiles({ dir });
    const byName = Object.fromEntries(list.map((f) => [f.name, f]));
    assert.strictEqual(byName['scenes.json'].kind, 'editable');
    assert.strictEqual(byName['amp-state.json'].kind, 'state');
    assert.strictEqual(byName['creds.json'].kind, 'secret');
    assert.ok(typeof byName['scenes.json'].size === 'number');

    // read: editable + state OK, secret refused
    assert.ok(readDataFile('scenes.json', { dir }).includes('"id"'));
    assert.ok(readDataFile('amp-state.json', { dir }).includes('marantz'));
    assert.throws(() => readDataFile('creds.json', { dir }), /secret/i);

    // write: editable OK (and must be valid JSON)
    writeDataFile('scenes.json', '[{"id":"b"}]', { dir });
    assert.ok(readDataFile('scenes.json', { dir }).includes('"b"'));
    assert.throws(
        () => writeDataFile('scenes.json', 'not json', { dir }),
        /JSON/i,
    );
    // write: state + secret refused
    assert.throws(
        () => writeDataFile('amp-state.json', '{}', { dir }),
        /read-?only|state/i,
    );
    assert.throws(() => writeDataFile('creds.json', '{}', { dir }), /secret/i);

    // path traversal refused
    assert.throws(() => readDataFile('../.env', { dir }), /\.json|escape/i);

    fs.rmSync(dir, { recursive: true, force: true });

    console.log('All dataFiles tests passed');
}

run();
