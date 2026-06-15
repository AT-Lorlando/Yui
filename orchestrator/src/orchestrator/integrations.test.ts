// orchestrator/src/orchestrator/integrations.test.ts
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    applyIntegrations,
    validateIntegrations,
    maskIntegrations,
    loadIntegrations,
    saveIntegrations,
    type IntegrationsMap,
} from './integrations';
import type { McpServerConfig } from './types';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'yui-integrations-'));
}

function run(): void {
    const servers: McpServerConfig[] = [
        { name: 'mcp-hue', command: 'node', args: ['hue.js'] },
        { name: 'mcp-nuki', command: 'node', args: ['nuki.js'] },
    ];

    // ── applyIntegrations: maps env per server, leaves others untouched ───────
    const map: IntegrationsMap = {
        'mcp-hue': { HUE_BRIDGE_IP: '10.0.0.42' },
        'mcp-unknown': { FOO: 'bar' }, // no matching server → ignored
    };
    const applied = applyIntegrations(servers, map);
    assert.deepStrictEqual(applied[0].env, { HUE_BRIDGE_IP: '10.0.0.42' });
    assert.strictEqual(applied[1].env, undefined); // mcp-nuki has no entry
    // input must not be mutated
    assert.strictEqual(servers[0].env, undefined);

    // empty entry → no env injected
    const applied2 = applyIntegrations(servers, { 'mcp-hue': {} });
    assert.strictEqual(applied2[0].env, undefined);

    // ── validateIntegrations ──────────────────────────────────────────────────
    assert.deepStrictEqual(
        validateIntegrations({ 'mcp-hue': { HUE_BRIDGE_IP: '10.0.0.42' } }),
        [],
    );
    assert.ok(
        validateIntegrations({ 'mcp-hue': { 'lower-case': 'x' } as any })
            .length > 0,
        'env key must be UPPER_SNAKE',
    );
    assert.ok(
        validateIntegrations({ 'mcp-hue': { K: { nested: 1 } } as any })
            .length > 0,
        'value must be a scalar',
    );
    assert.ok(
        validateIntegrations({ 'mcp-hue': 'notanobject' } as any).length > 0,
        'server entry must be an object',
    );

    // ── maskIntegrations: sensitive keys hidden, infra kept ───────────────────
    const masked = maskIntegrations({
        'mcp-nuki': { NUKI_HOST: '10.0.0.7', NUKI_TOKEN: 'supersecret' },
    });
    assert.strictEqual(masked['mcp-nuki'].NUKI_HOST, '10.0.0.7');
    assert.notStrictEqual(masked['mcp-nuki'].NUKI_TOKEN, 'supersecret');
    assert.ok(masked['mcp-nuki'].NUKI_TOKEN.includes('•'));

    // ── load (missing → {}) + save (merge + persist) ──────────────────────────
    const dir = tmpDir();
    assert.deepStrictEqual(loadIntegrations({ dir }), {});

    const saved = saveIntegrations(
        { 'mcp-hue': { HUE_BRIDGE_IP: '10.0.0.42' } },
        { dir },
    );
    assert.strictEqual(saved['mcp-hue'].HUE_BRIDGE_IP, '10.0.0.42');
    assert.deepStrictEqual(loadIntegrations({ dir }), saved); // persisted

    // partial merge keeps other servers, deep-merges keys within a server
    const merged = saveIntegrations(
        { 'mcp-nuki': { NUKI_HOST: '10.0.0.7' } },
        { dir },
    );
    assert.strictEqual(merged['mcp-hue'].HUE_BRIDGE_IP, '10.0.0.42'); // kept
    assert.strictEqual(merged['mcp-nuki'].NUKI_HOST, '10.0.0.7');

    // invalid patch throws, file unchanged
    assert.throws(
        () => saveIntegrations({ 'mcp-hue': { bad: 'x' } as any }, { dir }),
        'invalid patch must throw',
    );
    assert.strictEqual(
        loadIntegrations({ dir })['mcp-hue'].HUE_BRIDGE_IP,
        '10.0.0.42',
    );

    fs.rmSync(dir, { recursive: true, force: true });

    console.log('All integrations tests passed');
}

run();
