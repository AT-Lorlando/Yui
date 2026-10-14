import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    OrderStore,
    expireOrders,
    ordersPrompt,
    ORDER_DEFAULT_DAYS,
    ORDERS_MAX,
    MailOrder,
} from './orders';

const DAY = 86_400_000;

function tmpStore(): { store: OrderStore; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-'));
    const file = path.join(dir, 'mail-orders.json');
    return { store: new OrderStore(file), file };
}

function run(): void {
    const now = new Date(2026, 9, 14, 12, 0, 0).getTime();

    // défaut 14 jours
    {
        const { store, file } = tmpStore();
        const o = store.add(
            { text: '  Réponse de Michel ', source: 'user' },
            now,
        );
        assert.ok(/^o-[0-9a-f]{6}$/.test(o.id));
        assert.strictEqual(o.text, 'Réponse de Michel');
        assert.strictEqual(o.expiresAt, now + ORDER_DEFAULT_DAYS * DAY);
        assert.strictEqual(o.state, 'active');
        assert.strictEqual(new OrderStore(file).all().length, 1);
        assert.strictEqual(
            store.add({ text: 'x', days: 2, source: 'voice' }, now).expiresAt,
            now + 2 * DAY,
        );
    }

    // expiration lazy
    {
        const { store } = tmpStore();
        store.add({ text: 'a', days: 1, source: 'user' }, now);
        store.add({ text: 'b', days: 5, source: 'user' }, now);
        assert.strictEqual(store.active(now).length, 2);
        const later = store.active(now + 2 * DAY);
        assert.deepStrictEqual(
            later.map((o) => o.text),
            ['b'],
        );
        assert.strictEqual(
            store.all().find((o) => o.text === 'a')?.state,
            'expired',
        );
        const pure = expireOrders(store.all(), now + 10 * DAY);
        assert.ok(pure.every((o) => o.state === 'expired'));
    }

    // origin upsert
    {
        const { store } = tmpStore();
        const a = store.add(
            { text: 'colis', source: 'connector', origin: 'parcel:1' },
            now,
        );
        const b = store.add(
            {
                text: 'colis lundi',
                days: 3,
                source: 'connector',
                origin: 'parcel:1',
            },
            now + 1000,
        );
        assert.strictEqual(b.id, a.id);
        assert.strictEqual(store.all().length, 1);
        assert.strictEqual(store.byOrigin('parcel:1')?.text, 'colis lundi');
        assert.strictEqual(
            store.byOrigin('parcel:1')?.expiresAt,
            now + 1000 + 3 * DAY,
        );
        assert.strictEqual(store.byOrigin('nope'), null);
    }

    // fulfill
    {
        const { store } = tmpStore();
        const o = store.add({ text: 'a', source: 'user' }, now);
        const f = store.fulfill(o.id, 'mail-9', 'Reçu', now + 5);
        assert.strictEqual(f?.state, 'fulfilled');
        assert.strictEqual(f?.fulfilledAt, now + 5);
        assert.strictEqual(f?.fulfilledBy, 'mail-9');
        assert.strictEqual(f?.result, 'Reçu');
        assert.strictEqual(store.active(now).length, 0);
        assert.strictEqual(
            store.fulfill('o-zzzzzz', 'm', undefined, now),
            null,
        );
    }

    // ordersPrompt
    {
        const orders: MailOrder[] = [
            {
                id: 'o-3',
                text: 'Réponse de Michel',
                createdAt: now,
                expiresAt: new Date(2026, 9, 28, 12).getTime(),
                source: 'user',
                state: 'active',
            },
            {
                id: 'o-4',
                text: 'fini',
                createdAt: now,
                expiresAt: now + DAY,
                source: 'user',
                state: 'fulfilled',
            },
        ];
        assert.strictEqual(
            ordersPrompt(orders),
            "- [o-3] Réponse de Michel (jusqu'au 28/10)",
        );
        assert.strictEqual(ordersPrompt([]), '');
        assert.strictEqual(ordersPrompt([orders[1]]), '');
    }

    // validations
    {
        const { store } = tmpStore();
        assert.throws(
            () => store.add({ text: '   ', source: 'user' }, now),
            Error,
        );
        assert.throws(
            () => store.add({ text: 'x'.repeat(301), source: 'user' }, now),
            Error,
        );
        store.add({ text: 'x'.repeat(300), source: 'user', origin: 'z' }, now);
        for (let i = 1; i < ORDERS_MAX; i++)
            store.add({ text: `o${i}`, source: 'user' }, now);
        assert.throws(
            () => store.add({ text: 'trop', source: 'user' }, now),
            Error,
        );
        // upsert reste permis à saturation
        store.add({ text: 'o1', source: 'connector', origin: 'z' }, now);
    }

    // remove
    {
        const { store } = tmpStore();
        const o = store.add({ text: 'a', source: 'user' }, now);
        assert.strictEqual(store.remove(o.id), true);
        assert.strictEqual(store.remove(o.id), false);
        assert.strictEqual(store.all().length, 0);
    }

    console.log('orders: all tests passed');
}

run();
