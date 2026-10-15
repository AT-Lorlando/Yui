import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ConnectorBusy,
    ConnectorNoEvents,
    ConnectorNotFound,
    ConnectorRunner,
} from './runner';
import type { IngestOutcome } from './ingest';
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

process.on('unhandledRejection', () => {
    console.error('unhandled rejection');
    process.exit(1);
});

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
            // ingest() rejette pour cette clé (voir `ingest` ci-dessous) —
            // vérifie que le chemin subscribe (fire-and-forget) l'attrape
            // au lieu de laisser une unhandled rejection.
            emit(ev('presence', 'boom'));
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
        ingest: async (e) => {
            if (e.source === 'presence' && e.key === 'boom') {
                throw new Error('ingest kaboom');
            }
            ingested.push(`${e.source}:${e.key}`);
            return 'accepted' as const;
        },
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

    // ingest() a rejeté pour presence:boom — le chemin subscribe (fire-and-
    // forget) doit l'attraper et journaliser un warning, pas planter en
    // unhandled rejection (voir process.on('unhandledRejection') ci-dessus).
    assert.ok(
        warnings.some((w) => w.includes('presence') && w.includes('ingest')),
    );

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

    await statusTests();

    console.log('All runner tests passed');
}

/** Statut des connecteurs (page Secrétaire) et relève manuelle. */
async function statusTests(): Promise<void> {
    let clock = NOW;
    let mode: 'ok' | 'fail' | 'hang' | 'slow' = 'ok';
    let batch: Event[] = [];
    const outcomes: IngestOutcome[] = ['accepted', 'held', 'deduplicated'];
    let n = 0;
    const longMsg = 'x'.repeat(500);
    const ctl: ConnectorDef = {
        id: 'ctl',
        name: 'Ctl',
        description: 'piloté',
        defaultEnabled: true,
        pollMinutes: 10,
        async events() {
            if (mode === 'fail') throw new Error(longMsg);
            if (mode === 'hang') return new Promise<Event[]>(() => {});
            if (mode === 'slow') await sleep(30);
            return batch;
        },
    };
    const push: ConnectorDef = {
        id: 'push',
        name: 'Push',
        description: '',
        defaultEnabled: true,
        subscribe: () => () => {},
    };
    const snap: ConnectorDef = {
        id: 'snap',
        name: 'Snap',
        description: '',
        defaultEnabled: true,
        async snapshot() {
            return [];
        },
    };
    const both: ConnectorDef = {
        ...ctl,
        id: 'both',
        subscribe: () => () => {},
    };
    // État pré-rempli : `_status` relu au constructeur.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-runner-'));
    const ctlFile = path.join(dir, 'ctl.json');
    fs.writeFileSync(
        ctlFile,
        JSON.stringify({
            _status: { lastPollAt: 11, lastOkAt: 10, lastError: 'avant' },
        }),
    );
    const runner = new ConnectorRunner({
        connectors: [ctl, push, snap, both],
        isEnabled: () => true,
        settings: () => ({}),
        callTool: async () => null,
        presence: () => 'home',
        ingest: async () => outcomes[n++ % outcomes.length],
        now: () => clock,
        stateFile: (id) => (id === 'ctl' ? ctlFile : undefined),
        timers: {
            setInterval: (() => 1) as any,
            clearInterval: (() => {}) as any,
        },
        pollTimeoutMs: 50,
        log: { info: () => {}, warn: () => {} },
    });

    let st = runner.status();
    assert.deepStrictEqual(
        st.map((s) => [s.id, s.mode]),
        [
            ['ctl', 'poll'],
            ['push', 'subscribe'],
            ['snap', 'snapshot'],
            ['both', 'poll+subscribe'],
        ],
    );
    assert.strictEqual(st[0].lastPollAt, 11, '_status relu');
    assert.strictEqual(st[0].lastOkAt, 10);
    assert.strictEqual(st[0].lastError, 'avant');
    assert.strictEqual(st[0].failures, 0);
    assert.strictEqual(st[0].pollMinutes, 10);
    assert.strictEqual(st[0].nextPollAt, undefined, 'pas de timer avant start');

    // Poll OK : horodatages, erreur effacée, sorts rendus dans `recent`.
    batch = [ev('ctl', 'a'), ev('ctl', 'b')];
    clock = NOW + 1000;
    const counts = await runner.pollNow('ctl');
    assert.deepStrictEqual(counts, {
        accepted: 1,
        expired: 0,
        deduplicated: 0,
        held: 1,
        ignored: 0,
    });
    st = runner.status();
    assert.strictEqual(st[0].lastPollAt, NOW + 1000);
    assert.strictEqual(st[0].lastOkAt, NOW + 1000);
    assert.strictEqual(st[0].lastError, undefined);
    assert.strictEqual(st[0].failures, 0);
    assert.deepStrictEqual(
        st[0].recent.map((r) => [r.key, r.outcome]),
        [
            ['b', 'held'],
            ['a', 'accepted'],
        ],
        'plus récent en tête',
    );
    // Persisté sous `_status`.
    const saved = JSON.parse(fs.readFileSync(ctlFile, 'utf-8'))._status;
    assert.strictEqual(saved.lastOkAt, NOW + 1000);
    assert.strictEqual(saved.lastError, undefined);

    // Poll en erreur : message tronqué, lastOkAt inchangé.
    mode = 'fail';
    clock = NOW + 2000;
    await runner.poll('ctl');
    st = runner.status();
    assert.strictEqual(st[0].lastError!.length, 200);
    assert.strictEqual(st[0].lastErrorAt, NOW + 2000);
    assert.strictEqual(st[0].lastPollAt, NOW + 2000);
    assert.strictEqual(st[0].failures, 1);
    assert.strictEqual(st[0].lastOkAt, NOW + 1000);
    // pollNow remonte l'erreur du poll à l'appelant.
    await assert.rejects(runner.pollNow('ctl'), /xxx/);
    assert.strictEqual(runner.status()[0].failures, 2);

    // Timeout = erreur.
    mode = 'hang';
    await runner.poll('ctl');
    st = runner.status();
    assert.strictEqual(st[0].failures, 3);
    assert.ok(/délai/.test(st[0].lastError!));

    // `recent` borné à 5.
    mode = 'ok';
    batch = ['c', 'd', 'e', 'f', 'g', 'h'].map((k) => ev('ctl', k));
    await runner.pollNow('ctl');
    st = runner.status();
    assert.strictEqual(st[0].failures, 0);
    assert.deepStrictEqual(
        st[0].recent.map((r) => r.key),
        ['h', 'g', 'f', 'e', 'd'],
    );

    // Refus typés.
    await assert.rejects(runner.pollNow('nope'), ConnectorNotFound);
    await assert.rejects(runner.pollNow('push'), ConnectorNoEvents);
    mode = 'slow';
    batch = [];
    const running = runner.pollNow('ctl');
    assert.strictEqual(runner.status()[0].polling, true);
    await assert.rejects(runner.pollNow('ctl'), ConnectorBusy);
    await running;
    assert.strictEqual(runner.status()[0].polling, false);

    // Timer en marche → prochaine relève annoncée.
    mode = 'ok';
    clock = NOW + 5000;
    runner.start();
    await sleep(5);
    st = runner.status();
    assert.strictEqual(st[0].nextPollAt, NOW + 5000 + 10 * 60_000);
    runner.stop();
    assert.strictEqual(runner.status()[0].nextPollAt, undefined);
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
