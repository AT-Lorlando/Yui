import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SaidMemory, saidDurationMs, DAY_MS } from './said';

async function run(): Promise<void> {
    const T = new Date('2026-09-27T10:00:00').getTime();
    // Durées par nature.
    assert.strictEqual(saidDurationMs('agenda-far', T), null);
    assert.strictEqual(saidDurationMs('request', T), 7 * DAY_MS);
    assert.strictEqual(saidDurationMs('digest', T), 7 * DAY_MS);
    assert.strictEqual(saidDurationMs('alert', T), DAY_MS);
    assert.strictEqual(saidDurationMs('info', T), DAY_MS);
    assert.strictEqual(saidDurationMs('postit-stale', T), 7 * DAY_MS);
    const midnight = new Date('2026-09-28T00:00:00').getTime();
    assert.strictEqual(saidDurationMs('agenda-today', T), midnight - T);

    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'yui-said-')),
        'said.json',
    );
    const m = new SaidMemory(file);
    m.markSaid(
        [
            {
                subject: 'deliveries:colis-1-delivered',
                fingerprint: 'a',
                nature: 'info',
            },
        ],
        'speak',
        T,
    );
    assert.strictEqual(
        m.isSaid('deliveries:colis-1-delivered', 'a', T + 1000),
        true,
    );
    assert.strictEqual(
        m.isSaid('deliveries:colis-1-delivered', 'b', T + 1000),
        false,
        'faits changés → pas dit',
    );
    assert.strictEqual(
        m.isSaid('deliveries:colis-1-delivered', 'a', T + DAY_MS + 1),
        false,
        'expiré',
    );
    assert.strictEqual(m.isSaid('unknown', 'a', T), false);

    // Définitif.
    m.markSaid(
        [
            {
                subject: 'calendar:agenda-e2-new-x',
                fingerprint: 'x',
                nature: 'agenda-far',
            },
        ],
        'notify',
        T,
    );
    assert.strictEqual(
        m.isSaid('calendar:agenda-e2-new-x', 'x', T + 400 * DAY_MS),
        true,
    );

    // Clôture et 👎.
    m.markSaid(
        [
            {
                subject: 'mail:mail-action-m1',
                fingerprint: 'f',
                nature: 'request',
            },
        ],
        'brief',
        T,
    );
    m.close('mail:mail-action-m1');
    assert.strictEqual(
        m.isSaid('mail:mail-action-m1', 'f', T + 1),
        false,
        'clos → oublié',
    );
    m.markSaid(
        [{ subject: 'weather:rain-now', fingerprint: 'r', nature: 'alert' }],
        'speak',
        T,
    );
    m.downvote(['weather:rain-now'], T);
    assert.strictEqual(
        m.isSaid('weather:rain-now', 'r', T + 29 * DAY_MS),
        true,
        '👎 → 30 jours',
    );
    assert.strictEqual(
        m.isSaid('weather:rain-now', 'r', T + 31 * DAY_MS),
        false,
    );

    // Persistance + purge.
    const m2 = new SaidMemory(file);
    assert.strictEqual(m2.isSaid('calendar:agenda-e2-new-x', 'x', T), true);
    m2.purge(T + 60 * DAY_MS);
    assert.strictEqual(m2.size(), 1, 'seul le définitif survit à la purge');
    // Fichier corrompu → vide, sans lever.
    fs.writeFileSync(file, '{nope');
    assert.strictEqual(new SaidMemory(file).size(), 0);

    // list / clear / nature / downvoted (page Secrétaire).
    {
        const f = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'yui-said2-')),
            'said.json',
        );
        const n = new SaidMemory(f);
        n.markSaid(
            [{ subject: 'a:1', fingerprint: 'x', nature: 'alert' }],
            'speak',
            T,
        );
        n.markSaid(
            [{ subject: 'b:2', fingerprint: 'y', nature: 'agenda-far' }],
            'brief',
            T + 10,
        );
        n.downvote(['a:1'], T + 20);
        const l = n.list();
        assert.deepStrictEqual(
            l.map((e) => e.subject),
            ['b:2', 'a:1'],
            "plus récent d'abord",
        );
        assert.strictEqual(l[0].nature, 'agenda-far');
        assert.strictEqual(l[0].until, null);
        assert.strictEqual(l[0].downvoted, false);
        assert.strictEqual(l[1].nature, 'alert');
        assert.strictEqual(l[1].downvoted, true);
        assert.strictEqual(
            new SaidMemory(f).list()[1].downvoted,
            true,
            'persisté',
        );
        // close renvoie l'existence.
        assert.strictEqual(n.close('zzz'), false);
        assert.strictEqual(n.close('b:2'), true);
        n.clear();
        assert.strictEqual(n.size(), 0);
        assert.strictEqual(new SaidMemory(f).size(), 0, 'clear persisté');
        // Ancien fichier sans nature.
        fs.writeFileSync(
            f,
            JSON.stringify({
                'old:1': {
                    at: 5,
                    channel: 'speak',
                    fingerprint: 'f',
                    until: null,
                },
            }),
        );
        const old = new SaidMemory(f).list();
        assert.strictEqual(old[0].nature, null);
        assert.strictEqual(old[0].downvoted, false);
    }
    console.log('All said tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
