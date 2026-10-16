import assert from 'assert';
import { runBulkEntries } from './bulkRun';
import type { BulkEntry } from './bulkStates';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
    // Une première entrée lente ne retarde pas la seconde : elles partent
    // ensemble.
    {
        const started: Record<string, number> = {};
        const t0 = Date.now();
        const entries: BulkEntry[] = [
            { target: 'Lent', on: true },
            { target: 'Rapide', on: true },
            { target: 'Autre', on: true },
        ];
        const out = await runBulkEntries(
            entries,
            () => false,
            async (e) => {
                started[e.target] = Date.now() - t0;
                await sleep(e.target === 'Lent' ? 200 : 10);
                return `${e.target} ok`;
            },
        );
        assert.ok(started.Rapide < 50, `Rapide started at ${started.Rapide}`);
        assert.ok(started.Autre < 50, `Autre started at ${started.Autre}`);
        assert.ok(Date.now() - t0 < 350, 'parallel, not 220 ms + sequential');
        // Ordre des résultats = ordre des entrées.
        assert.deepStrictEqual(out, ['Lent ok', 'Rapide ok', 'Autre ok']);
    }

    // Une lampe en échec : les autres passent, l'erreur rejoint le texte.
    {
        const out = await runBulkEntries(
            [
                { target: 'A', on: true },
                { target: 'B', on: true },
            ],
            () => false,
            async (e) => {
                if (e.target === 'A') throw new Error('bridge timeout');
                return 'B ok';
            },
        );
        assert.strictEqual(out[0], 'A : échec (bridge timeout)');
        assert.strictEqual(out[1], 'B ok');
    }

    // Govee : en séquence, APRÈS le lancement du lot Hue (qui n'attend pas
    // les Govee), échec Govee capturé.
    {
        const log: string[] = [];
        let goveeRunning = 0;
        const entries: BulkEntry[] = [
            { target: 'Govee 1', on: true },
            { target: 'Hue 1', on: true },
            { target: 'Govee 2', on: true },
            { target: 'Hue 2', on: true },
        ];
        const out = await runBulkEntries(
            entries,
            (e) => e.target.startsWith('Govee'),
            async (e) => {
                log.push(`start ${e.target}`);
                if (e.target.startsWith('Govee')) {
                    goveeRunning++;
                    assert.strictEqual(goveeRunning, 1, 'Govee sequential');
                    await sleep(30);
                    goveeRunning--;
                    if (e.target === 'Govee 2') throw new Error('udp');
                } else {
                    await sleep(5);
                }
                log.push(`end ${e.target}`);
                return `${e.target} ok`;
            },
        );
        assert.deepStrictEqual(log.slice(0, 2), ['start Hue 1', 'start Hue 2']);
        assert.ok(
            log.indexOf('start Govee 2') > log.indexOf('end Govee 1'),
            'Govee 2 waits for Govee 1',
        );
        assert.deepStrictEqual(out, [
            'Govee 1 ok',
            'Hue 1 ok',
            'Govee 2 : échec (udp)',
            'Hue 2 ok',
        ]);
    }

    console.log('All bulkRun tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
