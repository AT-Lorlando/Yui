// orchestrator/src/orchestrator/prompts.manifest.test.ts
import assert from 'assert';
import {
    reconcileManifest,
    resolveCoreFiles,
    resolveDomainFile,
    type PromptEntry,
} from './prompts';

function run(): void {
    // ── reconcileManifest: seed from files when manifest empty ────────────────
    const files = [
        '00-personality.md',
        '01-core-rules.md',
        'domains/domotique.md',
    ];
    const seeded = reconcileManifest([], files);
    const personality = seeded.find((e) => e.file === '00-personality.md')!;
    assert.strictEqual(personality.layer, 'core');
    assert.strictEqual(personality.enabled, true);
    const domo = seeded.find((e) => e.file === 'domains/domotique.md')!;
    assert.strictEqual(domo.layer, 'domain');
    assert.strictEqual(domo.domain, 'domotique'); // basename → group name
    assert.strictEqual(domo.enabled, true);

    // ── reconcileManifest: preserve existing fields, add new, drop orphans ────
    const existing: PromptEntry[] = [
        { file: '00-personality.md', layer: 'core', enabled: false, order: 0 },
        { file: 'gone.md', layer: 'core', enabled: true, order: 9 },
    ];
    const reconciled = reconcileManifest(existing, [
        '00-personality.md',
        '02-agent-quality.md',
    ]);
    // existing entry keeps its disabled flag
    assert.strictEqual(
        reconciled.find((e) => e.file === '00-personality.md')!.enabled,
        false,
    );
    // orphan dropped
    assert.ok(!reconciled.find((e) => e.file === 'gone.md'));
    // new file added, enabled, appended after max order
    const added = reconciled.find((e) => e.file === '02-agent-quality.md')!;
    assert.strictEqual(added.enabled, true);
    assert.strictEqual(added.layer, 'core');
    assert.ok(added.order > 0);

    // ── resolveCoreFiles: enabled core, ordered, domains excluded ─────────────
    const entries: PromptEntry[] = [
        { file: '01-core-rules.md', layer: 'core', enabled: true, order: 1 },
        { file: '00-personality.md', layer: 'core', enabled: true, order: 0 },
        { file: '02-heavy.md', layer: 'core', enabled: false, order: 2 },
        {
            file: 'domains/domotique.md',
            layer: 'domain',
            domain: 'domotique',
            enabled: true,
            order: 0,
        },
    ];
    assert.deepStrictEqual(resolveCoreFiles(entries), [
        '00-personality.md',
        '01-core-rules.md',
    ]); // sorted by order, disabled + domain excluded

    // ── resolveDomainFile: enabled match by group name ────────────────────────
    assert.strictEqual(
        resolveDomainFile(entries, 'domotique'),
        'domains/domotique.md',
    );
    assert.strictEqual(resolveDomainFile(entries, 'inconnu'), null);
    // disabled domain → null
    const disabledDomain: PromptEntry[] = [
        {
            file: 'domains/x.md',
            layer: 'domain',
            domain: 'x',
            enabled: false,
            order: 0,
        },
    ];
    assert.strictEqual(resolveDomainFile(disabledDomain, 'x'), null);

    console.log('All prompts.manifest tests passed');
}

run();
