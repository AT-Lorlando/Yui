// Livraisons → ordres de lecture automatiques : un colis expédié fait guetter
// au lecteur IA le mail du transporteur (date, transporteur, suivi) ; la
// livraison referme l'ordre.
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConnectorContext } from '../connector';
import type { PresenceState } from '../../presence';

// listParcels() lit dataPath('deliveries.json') : isoler YUI_DATA_DIR AVANT
// de résoudre les modules.
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dlv-'));
const { dataPath } = require('@yui/shared') as typeof import('@yui/shared');
const { deliveriesConnector, parcelOrderText } =
    require('./deliveries') as typeof import('./deliveries');
const { ConnectorState } =
    require('../connectorState') as typeof import('../connectorState');
const { OrderStore, ORDERS_MAX, ORDER_TEXT_MAX } =
    require('../mail/orders') as typeof import('../mail/orders');

const NOW = new Date('2026-10-14T10:00:00').getTime();
const DAY = 86_400_000;

function writeParcels(
    parcels: Array<{
        id: string;
        status: string;
        content?: string;
        label?: string;
        tracking: string;
    }>,
): void {
    const file = dataPath('deliveries.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
        file,
        JSON.stringify(
            parcels.map((p) => ({
                carrier: 'colissimo',
                source: 'mail',
                events: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
                ...p,
            })),
        ),
    );
}

async function run(): Promise<void> {
    const ordersFile = path.join(process.env.YUI_DATA_DIR!, 'orders.json');
    const orders = new OrderStore(ordersFile);
    const warns: string[] = [];
    const ctx: ConnectorContext = {
        // Aucun mail : evaluateDeliveries ne produit rien.
        callTool: async () => 'Aucun email',
        settings: {},
        state: new ConnectorState(),
        presence: () => 'home' as PresenceState,
        now: () => NOW,
        log: { info: () => {}, warn: (m) => warns.push(m) },
    };
    const d = deliveriesConnector(async () => '', orders);

    writeParcels([
        { id: 'p1', status: 'shipped', content: 'Casque', tracking: 'T1' },
        { id: 'p2', status: 'in_transit', label: 'ASOS', tracking: 'T2' },
        { id: 'p3', status: 'out_for_delivery', tracking: 'T3' },
        { id: 'p4', status: 'announced', content: 'Livre', tracking: 'T4' },
    ]);
    assert.deepStrictEqual(await d.events!(ctx), []);
    const active = orders.active(NOW);
    assert.strictEqual(active.length, 3, 'un ordre par colis en route');
    const o1 = orders.byOrigin('parcel:p1')!;
    assert.strictEqual(
        o1.text,
        'Commande Casque : extraire la date de livraison estimée, le transporteur et le numéro de suivi',
    );
    assert.strictEqual(o1.source, 'connector');
    assert.strictEqual(o1.expiresAt, NOW + 21 * DAY);
    assert.ok(orders.byOrigin('parcel:p2')!.text.startsWith('Commande ASOS'));
    assert.ok(orders.byOrigin('parcel:p3')!.text.startsWith('Commande T3'));
    assert.strictEqual(orders.byOrigin('parcel:p4'), null, 'annoncé : rien');

    // Poll suivant : aucun doublon.
    await d.events!(ctx);
    assert.strictEqual(orders.all().length, 3, 'ordre posé une fois par colis');

    // Ordre satisfait par le lecteur : pas reposé au poll suivant.
    orders.fulfill(o1.id, 'm1', 'Livraison jeudi', NOW);
    await d.events!(ctx);
    assert.strictEqual(
        orders.all().length,
        3,
        'un ordre satisfait n’est pas reposé',
    );

    // Livraison : l'ordre encore actif passe à « satisfait ».
    writeParcels([
        { id: 'p1', status: 'delivered', content: 'Casque', tracking: 'T1' },
        { id: 'p2', status: 'delivered', label: 'ASOS', tracking: 'T2' },
        { id: 'p3', status: 'out_for_delivery', tracking: 'T3' },
    ]);
    await d.events!(ctx);
    const p2 = orders.all().find((o) => o.origin === 'parcel:p2')!;
    assert.strictEqual(p2.state, 'fulfilled');
    assert.strictEqual(p2.result, 'livré');
    assert.strictEqual(
        orders.all().find((o) => o.origin === 'parcel:p1')!.result,
        'Livraison jeudi',
        'un ordre déjà satisfait n’est pas réécrit',
    );
    assert.strictEqual(orders.active(NOW).length, 1);

    // Plafond d'ordres actifs : l'erreur est journalisée, le poll continue.
    const full = new OrderStore(
        path.join(process.env.YUI_DATA_DIR!, 'full.json'),
    );
    for (let i = 0; i < ORDERS_MAX; i++) {
        full.add({ text: `Ordre ${i}`, source: 'user' }, NOW);
    }
    const d2 = deliveriesConnector(async () => '', full);
    assert.deepStrictEqual(await d2.events!(ctx), []);
    assert.ok(
        warns.some((w) => w.includes('parcel:p3')),
        `avertissement attendu : ${warns.join(' | ')}`,
    );

    // Libellé de colis très long : l'ordre est rogné, jamais refusé.
    const long = parcelOrderText('Casque '.repeat(80));
    assert.ok(long.length <= ORDER_TEXT_MAX, `${long.length}`);
    assert.ok(long.startsWith('Commande Casque'));
    assert.ok(long.includes('…'));
    assert.ok(long.endsWith('le numéro de suivi'));
    assert.strictEqual(
        parcelOrderText('Casque'),
        'Commande Casque : extraire la date de livraison estimée, le transporteur et le numéro de suivi',
    );
    const store = new OrderStore(
        path.join(process.env.YUI_DATA_DIR!, 'long-orders.json'),
    );
    store.add({ text: long, source: 'connector', origin: 'parcel:x' }, NOW);

    console.log('All deliveries connector tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
