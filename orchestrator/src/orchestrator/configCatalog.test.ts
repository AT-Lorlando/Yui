// orchestrator/src/orchestrator/configCatalog.test.ts
import assert from 'assert';
import { expectedDomains, INTEGRATIONS_CATALOG } from './configCatalog';

function run(): void {
    // ── expectedDomains: distinct prompt files, groups merged ─────────────────
    const domains = expectedDomains();
    const byDomain = Object.fromEntries(domains.map((d) => [d.domain, d]));

    // domotique.md is the target of both 'domotique' and 'domotique-jardin'
    assert.ok(byDomain.domotique, 'domotique domain expected');
    assert.strictEqual(byDomain.domotique.file, 'domotique.md');
    assert.ok(
        byDomain.domotique.groups.includes('domotique') &&
            byDomain.domotique.groups.includes('domotique-jardin'),
        'domotique should list both triggering groups',
    );

    // connaissance.md is the target of 'connaissance' and 'recherche'
    assert.ok(byDomain.connaissance.groups.includes('recherche'));

    // each file appears once (deduped)
    const files = domains.map((d) => d.file);
    assert.strictEqual(new Set(files).size, files.length, 'files deduped');

    // the four canonical domain files are present
    for (const f of [
        'domotique.md',
        'prevoyance.md',
        'secretariat.md',
        'connaissance.md',
    ]) {
        assert.ok(files.includes(f), `${f} expected`);
    }

    // ── integrations catalog: shape + secret flagging ─────────────────────────
    const hue = INTEGRATIONS_CATALOG['mcp-hue'];
    assert.ok(Array.isArray(hue) && hue.length > 0);
    const bridge = hue.find((k) => k.key === 'HUE_BRIDGE_IP');
    assert.ok(bridge && bridge.example && bridge.secret !== true);

    const nuki = INTEGRATIONS_CATALOG['mcp-nuki'];
    const token = nuki.find((k) => k.key === 'NUKI_TOKEN');
    assert.ok(
        token && token.secret === true,
        'NUKI_TOKEN must be flagged secret',
    );

    console.log('All configCatalog tests passed');
}

run();
