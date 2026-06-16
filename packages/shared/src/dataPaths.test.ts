// packages/shared/src/dataPaths.test.ts
import assert from 'assert';
import * as path from 'path';
import { categoryOf, dataPath, dataRoot, dataCategoryDirs } from './dataPaths';

function run(): void {
    // registry placement
    assert.strictEqual(categoryOf('scenes.json'), 'config');
    assert.strictEqual(categoryOf('amp-state.json'), 'state');
    assert.strictEqual(categoryOf('firebase-service-account.json'), 'shared');
    // paired tokens are state (placement), not shared
    assert.strictEqual(categoryOf('fcm-token.json'), 'state');
    assert.strictEqual(categoryOf('samsung-tv-token.json'), 'state');
    // unknown credential-ish name → shared
    assert.strictEqual(categoryOf('acme-service-account.json'), 'shared');
    // unknown benign name → config
    assert.strictEqual(categoryOf('mystery.json'), 'config');

    const prev = process.env.YUI_DATA_DIR;
    process.env.YUI_DATA_DIR = '/tmp/yui-x';
    assert.strictEqual(dataRoot(), '/tmp/yui-x');
    assert.strictEqual(
        dataPath('scenes.json'),
        path.join('/tmp/yui-x', 'config', 'scenes.json'),
    );
    assert.strictEqual(
        dataPath('memory.json'),
        path.join('/tmp/yui-x', 'state', 'memory.json'),
    );
    assert.deepStrictEqual(dataCategoryDirs(), {
        shared: path.join('/tmp/yui-x', 'shared'),
        config: path.join('/tmp/yui-x', 'config'),
        state: path.join('/tmp/yui-x', 'state'),
    });
    if (prev === undefined) delete process.env.YUI_DATA_DIR;
    else process.env.YUI_DATA_DIR = prev;

    console.log('All dataPaths tests passed');
}

run();
