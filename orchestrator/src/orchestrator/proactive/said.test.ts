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
    console.log('All said tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
