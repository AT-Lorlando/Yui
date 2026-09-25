import assert from 'assert';
import { ConnectorRunner } from './runner';
import type { ConnectorDef } from './connector';
import type { Event } from './events';

const NOW = 1_000_000;
const ev = (source: string, key: string): Event => ({
    source,
    key,
    kind: 'info',
    importance: 'info',
    subject: key,
    facts: [],
    at: NOW,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<void> {
    const ingested: string[] = [];
    const warnings: string[] = [];
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    let cleared = 0;
    let slowCalls = 0;
    let failing = 0;
    let unsubscribed = 0;

    const slow: ConnectorDef = {
        id: 'slow',
        name: 'Slow',
        description: '',
        defaultEnabled: true,
        pollMinutes: 5,
        async events() {
            slowCalls++;
            await sleep(30);
            return [ev('slow', `k${slowCalls}`)];
        },
        async snapshot() {
            return [{ label: 'slow', value: 'ok' }];
        },
    };
    const broken: ConnectorDef = {
        id: 'broken',
        name: 'Broken',
        description: '',
        defaultEnabled: true,
        pollMinutes: 5,
        async events() {
            failing++;
            throw new Error('boom');
        },
    };
    const hanging: ConnectorDef = {
        id: 'hang',
        name: 'Hang',
        description: '',
        defaultEnabled: true,
        pollMinutes: 5,
        events: () => new Promise(() => {}),
        snapshot: () => new Promise(() => {}),
    };
    const eventful: ConnectorDef = {
        id: 'presence',
        name: 'Presence',
        description: '',
        defaultEnabled: true,
        subscribe(_ctx, emit) {
            emit(ev('presence', 'arrived'));
            return () => {
                unsubscribed++;
            };
        },
    };
    const off: ConnectorDef = {
        id: 'off',
        name: 'Off',
        description: '',
        defaultEnabled: false,
        pollMinutes: 1,
        async events() {
            throw new Error('ne doit pas tourner');
        },
    };

    const runner = new ConnectorRunner({
        connectors: [slow, broken, hanging, eventful, off],
        isEnabled: (id) => id !== 'off',
        settings: () => ({}),
        callTool: async () => null,
        presence: () => 'home',
        ingest: async (e) => void ingested.push(`${e.source}:${e.key}`),
        now: () => NOW,
        timers: {
            setInterval: ((fn: () => void, ms: number) => {
                intervals.push({ fn, ms });
                return intervals.length as any;
            }) as any,
            clearInterval: (() => {
                cleared++;
            }) as any,
        },
        pollTimeoutMs: 50,
        log: { info: () => {}, warn: (m: string) => void warnings.push(m) },
    });

    assert.deepStrictEqual(runner.activeIds(), [
        'slow',
        'broken',
        'hang',
        'presence',
    ]);
    runner.start();
    // subscribe branché → événement ingéré tout de suite.
    assert.ok(ingested.includes('presence:arrived'));
    // Un intervalle par connecteur pollé actif (pas pour presence, pas pour off).
    assert.deepStrictEqual(
        intervals.map((i) => i.ms),
        [5 * 60_000, 5 * 60_000, 5 * 60_000],
    );

    // Laisse le poll immédiat du start (30 ms) se terminer avant de tester la
    // sérialisation des ticks suivants — sinon les deux ticks ci-dessous
    // tombent forcément pendant CE poll (verrou posé de façon synchrone dans
    // start(), avant que le test ne reprenne la main) et sont sautés tous les
    // deux, ce qui rendrait `slowCalls === 2` inatteignable.
    await sleep(40);

    // Poll sérialisé : deux ticks pendant qu'un poll est en cours → un seul appel.
    const p1 = runner.poll('slow');
    const p2 = runner.poll('slow');
    await Promise.all([p1, p2]);
    assert.strictEqual(
        slowCalls,
        2,
        'premier poll du start + un seul des deux ticks',
    );
    assert.ok(ingested.includes('slow:k1') && ingested.includes('slow:k2'));

    // Timeout : le connecteur qui pend ne bloque pas plus de pollTimeoutMs.
    const t0 = Date.now();
    await runner.poll('hang');
    assert.ok(Date.now() - t0 < 500);
    assert.ok(
        warnings.some((w) => w.includes('hang') && /timeout|délai/i.test(w)),
    );

    // Chaque échec est signalé jusqu'au 3e consécutif, puis silence. `broken`
    // a déjà échoué une fois pendant start() (échec 1) ; les quatre polls
    // suivants sont les échecs 2 à 5 → warnings aux échecs 2 et 3, puis
    // silence (échecs 4 et 5, pas de nouveau warning).
    const before = warnings.filter((w) => w.includes('broken')).length;
    await runner.poll('broken');
    await runner.poll('broken');
    await runner.poll('broken');
    await runner.poll('broken');
    const after = warnings.filter((w) => w.includes('broken')).length;
    assert.strictEqual(
        after - before,
        2,
        'warnings aux échecs 2 et 3, puis silence',
    );

    // Snapshots : par connecteur, le pendu est ignoré.
    const snaps = await runner.snapshots();
    assert.deepStrictEqual(snaps.slow, [{ label: 'slow', value: 'ok' }]);
    assert.strictEqual(snaps.hang, undefined);

    // stop : intervalles coupés, subscribe débranché.
    runner.stop();
    assert.strictEqual(cleared, 3);
    assert.strictEqual(unsubscribed, 1);

    console.log('All runner tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
