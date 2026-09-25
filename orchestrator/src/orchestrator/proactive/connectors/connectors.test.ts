import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { weatherConnector } from './weather';
import { presenceConnector } from './presence';
import { calendarConnector } from './calendar';
import { ConnectorState } from '../connectorState';
import type { ConnectorContext } from '../connector';
import type { Event } from '../events';
import type { PresenceState } from '../../presence';

// listParcels() (via deliveriesConnector.snapshot) lit dataPath('deliveries.json') :
// isoler YUI_DATA_DIR AVANT de résoudre ./deliveries pour ne pas toucher le
// vrai registre (même contrainte que engine-action.test.ts).
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-cn-'));
const { deliveriesConnector } =
    require('./deliveries') as typeof import('./deliveries');

const NOW = new Date('2026-09-25T10:00:00').getTime();
const ctx = (
    tools: Record<string, unknown>,
    settings: Record<string, unknown> = {},
): ConnectorContext => ({
    callTool: async (name) => tools[name] ?? null,
    settings,
    state: new ConnectorState(),
    presence: () => 'home' as PresenceState,
    now: () => NOW,
    log: { info: () => {}, warn: () => {} },
});

async function run(): Promise<void> {
    // Météo : pluie en cours → événement info, clé stable, ttl posé.
    const w = await weatherConnector.events!(
        ctx({
            get_current_weather: {
                city: 'Toulouse',
                temperature_c: 20,
                precipitation_mm: 3,
            },
            get_today_forecast: { periods: [] },
        }),
    );
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0]!.source, 'weather');
    assert.strictEqual(w[0]!.key, 'rain-now');
    assert.ok(w[0]!.ttlMs && w[0]!.ttlMs > 0);
    const ws = await weatherConnector.snapshot!(
        ctx({
            get_current_weather: {
                city: 'Toulouse',
                temperature_c: 20,
                precipitation_mm: 0,
            },
        }),
    );
    assert.deepStrictEqual(ws, [{ label: 'Météo', value: '20°C à Toulouse' }]);

    // Présence : subscribe relaie la transition ; snapshot = état courant.
    // `| undefined` plutôt que `| null` : avec `null`, tsc (strict) narrove la
    // réaffectation faite dans la closure passée à `presenceConnector` en
    // `never` sur les appels `cb!(...)` plus bas (limite connue du control
    // flow analysis sur les fonctions réassignées via callback).
    let cb: ((p: PresenceState, n: PresenceState) => void) | undefined;
    const emitted: Event[] = [];
    const pc = presenceConnector((fn) => {
        cb = fn;
    });
    const unsub = pc.subscribe!(
        ctx({
            list_doors: [{ name: 'Entrée', state: { stateName: 'unlocked' } }],
        }),
        (e) => emitted.push(e),
    );
    assert.ok(cb);
    cb!('home', 'away');
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(emitted[0]!.key, 'left-unlocked');
    assert.strictEqual(emitted[0]!.importance, 'urgent');
    unsub();
    cb!('away', 'home');
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(emitted.length, 1, 'débranché : plus rien');
    assert.deepStrictEqual(await pc.snapshot!(ctx({})), [
        { label: 'Présence', value: 'à la maison' },
    ]);

    // Agenda : rappel dans la fenêtre → clé = date+heure ; snapshot 24 h brut.
    const c = await calendarConnector.events!(
        ctx(
            {
                get_today: {
                    events: [
                        { title: 'Kinéis', date: '2026-09-25', start: '10:20' },
                    ],
                },
            },
            { remindMinutesBefore: 30 },
        ),
    );
    assert.strictEqual(c[0]!.key, 'event-2026-09-25-10:20');
    assert.strictEqual(c[0]!.kind, 'info');
    const cs = await calendarConnector.snapshot!(
        ctx({
            get_schedule: {
                days: [
                    {
                        date: '2026-09-25',
                        events: [
                            {
                                title: 'Kinéis',
                                start: '10:20',
                                location: 'Toulouse',
                            },
                        ],
                    },
                ],
            },
        }),
    );
    assert.ok(cs.some((f) => f.value.includes('Kinéis')));

    // Livraisons : snapshot depuis le registre (vide ici) ; events délègue à evaluateDeliveries.
    const d = deliveriesConnector(async () => '');
    assert.deepStrictEqual(await d.snapshot!(ctx({})), []);
    assert.deepStrictEqual(
        await d.events!(ctx({ search_emails: 'Aucun email' })),
        [],
    );

    console.log('All connectors tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
