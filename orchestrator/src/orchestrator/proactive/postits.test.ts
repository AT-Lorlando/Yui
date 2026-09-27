import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PostitRegistry, createPostitFor } from './postits';
import type { Event } from './events';

const NOW = new Date('2026-09-27T14:00:00').getTime();
const DAY_MS = 24 * 3600_000;
const log = { info: () => {}, warn: () => {} };

const ev = (key: string, over: Partial<Event> = {}): Event => ({
    source: 'mail',
    key,
    kind: 'request',
    importance: 'utile',
    subject: `Mail ${key}`,
    facts: ['Classé « action »'],
    at: NOW,
    todo: { title: `Répondre : ${key}`, description: `gmail:${key}` },
    ...over,
});

async function run(): Promise<void> {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'yui-postits-')),
        'postits.json',
    );

    // ── Registre : origine unique, compte du jour, clôture, persistance ──
    const reg = new PostitRegistry(file);
    assert.strictEqual(reg.has('mail:m1'), false);
    assert.strictEqual(reg.countToday(NOW), 0);
    reg.record('mail:m1', 'p1', NOW);
    reg.record('mail:m2', 'p2', NOW - DAY_MS); // hier
    assert.strictEqual(reg.has('mail:m1'), true);
    assert.strictEqual(reg.countToday(NOW), 1, 'seul le jour local compte');
    assert.strictEqual(reg.countToday(NOW + DAY_MS), 0, 'demain : rien');
    assert.deepStrictEqual(reg.open(), [
        { origin: 'mail:m1', postitId: 'p1' },
        { origin: 'mail:m2', postitId: 'p2' },
    ]);
    reg.markClosed('mail:m2');
    assert.deepStrictEqual(reg.open(), [{ origin: 'mail:m1', postitId: 'p1' }]);
    assert.strictEqual(
        reg.has('mail:m2'),
        true,
        'clos → toujours connu (jamais recréé)',
    );
    assert.strictEqual(reg.countToday(NOW - DAY_MS), 1, 'clos → compte encore');
    const reloaded = new PostitRegistry(file);
    assert.strictEqual(reloaded.has('mail:m1'), true);
    assert.deepStrictEqual(reloaded.open(), [
        { origin: 'mail:m1', postitId: 'p1' },
    ]);
    // Fichier corrompu → registre vide, sans lever.
    fs.writeFileSync(file, '{not json');
    assert.strictEqual(new PostitRegistry(file).open().length, 0);

    // ── createPostitFor : appel, enregistrement, ligne poussée dans facts ──
    const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    const okTool = async (tool: string, args?: Record<string, unknown>) => {
        calls.push({ tool, args });
        return { id: `p-${calls.length}`, title: args?.title };
    };
    const registry = new PostitRegistry();
    const deps = {
        registry,
        callTool: okTool,
        perDay: 2,
        now: () => NOW,
        log,
    };
    const a = ev('a');
    assert.deepStrictEqual(await createPostitFor(a, deps), { created: true });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.tool, 'create_postit');
    assert.deepStrictEqual(calls[0]!.args, {
        title: 'Répondre : a',
        description: 'gmail:a',
        tags: ['yui', 'mail'],
    });
    assert.deepStrictEqual(a.facts, [
        'Classé « action »',
        "Je t'ai mis un post-it : « Répondre : a »",
    ]);
    assert.strictEqual(registry.has('mail:a'), true);
    assert.deepStrictEqual(registry.open(), [
        { origin: 'mail:a', postitId: 'p-1' },
    ]);

    // Sans description : le champ n'est pas envoyé.
    const b = ev('b', { todo: { title: 'B' } });
    await createPostitFor(b, deps);
    assert.deepStrictEqual(calls[1]!.args, {
        title: 'B',
        tags: ['yui', 'mail'],
    });

    // Même origine → refus sans appel, facts intacts.
    const aAgain = ev('a');
    const dup = await createPostitFor(aAgain, deps);
    assert.strictEqual(dup.created, false);
    assert.ok(/origine/.test(dup.reason!), dup.reason);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(aAgain.facts, ['Classé « action »']);

    // Quota du jour atteint → refus sans appel.
    const c = ev('c');
    const quota = await createPostitFor(c, deps);
    assert.strictEqual(quota.created, false);
    assert.ok(/quota/.test(quota.reason!), quota.reason);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(registry.has('mail:c'), false);
    // Le lendemain, le quota repart.
    assert.strictEqual(
        (await createPostitFor(c, { ...deps, now: () => NOW + DAY_MS }))
            .created,
        true,
    );

    // Sans intention → rien.
    const plain = ev('d', { todo: undefined });
    assert.strictEqual((await createPostitFor(plain, deps)).created, false);
    assert.strictEqual(calls.length, 3);

    // Échec de l'outil → jamais levé, rien d'enregistré, facts intacts.
    const failing = {
        ...deps,
        registry: new PostitRegistry(),
        callTool: async () => {
            throw new Error('yoji injoignable');
        },
    };
    const e = ev('e');
    const failed = await createPostitFor(e, failing);
    assert.strictEqual(failed.created, false);
    assert.ok(/injoignable/.test(failed.reason!), failed.reason);
    assert.strictEqual(failing.registry.has('mail:e'), false);
    assert.deepStrictEqual(e.facts, ['Classé « action »']);

    // Réponse sans id → même traitement qu'un échec.
    const noId = {
        ...deps,
        registry: new PostitRegistry(),
        callTool: async () => ({ ok: true }),
    };
    const f = ev('f');
    assert.strictEqual((await createPostitFor(f, noId)).created, false);
    assert.strictEqual(noId.registry.has('mail:f'), false);
    assert.strictEqual(f.facts.length, 1);

    // Réponse JSON en texte (outil non parsé par le moteur) : acceptée.
    const textual = {
        ...deps,
        registry: new PostitRegistry(),
        callTool: async () => '{"id":"p-txt"}',
    };
    assert.strictEqual((await createPostitFor(ev('g'), textual)).created, true);
    assert.deepStrictEqual(textual.registry.open(), [
        { origin: 'mail:g', postitId: 'p-txt' },
    ]);

    console.log('All postits tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
