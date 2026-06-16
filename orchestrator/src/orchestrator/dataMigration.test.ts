// orchestrator/src/orchestrator/dataMigration.test.ts
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateDataLayout } from './dataMigration';

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'yui-mig-'));
}

function run(): void {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'scenes.json'), '[]');
    fs.writeFileSync(path.join(root, 'amp-state.json'), '{}');
    fs.writeFileSync(
        path.join(root, 'firebase-service-account.json'),
        '{"private_key":"x"}',
    );
    // dynamically-named service account → detected by content, not name
    fs.writeFileSync(
        path.join(root, 'acme-1234.json'),
        '{"type":"service_account","private_key":"y"}',
    );
    fs.mkdirSync(path.join(root, 'voice-debug'));
    fs.writeFileSync(path.join(root, 'story-index.json.pollués.bak'), 'junk');

    migrateDataLayout({ root });

    assert.ok(fs.existsSync(path.join(root, 'config', 'scenes.json')));
    assert.ok(fs.existsSync(path.join(root, 'state', 'amp-state.json')));
    assert.ok(
        fs.existsSync(
            path.join(root, 'shared', 'firebase-service-account.json'),
        ),
    );
    assert.ok(fs.existsSync(path.join(root, 'shared', 'acme-1234.json')));
    // debug dirs stay at root (written by Python voice server — out of scope)
    assert.ok(fs.existsSync(path.join(root, 'voice-debug')));
    assert.ok(!fs.existsSync(path.join(root, 'state', 'voice-debug')));
    // junk deleted
    assert.ok(!fs.existsSync(path.join(root, 'story-index.json.pollués.bak')));

    // idempotent: second run is a no-op, no throw
    migrateDataLayout({ root });
    assert.ok(fs.existsSync(path.join(root, 'config', 'scenes.json')));

    // does not clobber an existing target
    fs.writeFileSync(path.join(root, 'scenes.json'), 'NEW');
    migrateDataLayout({ root });
    assert.strictEqual(
        fs.readFileSync(path.join(root, 'config', 'scenes.json'), 'utf-8'),
        '[]',
    );

    fs.rmSync(root, { recursive: true, force: true });
    console.log('All dataMigration tests passed');
}

run();
