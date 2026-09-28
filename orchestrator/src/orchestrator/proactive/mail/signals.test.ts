import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
process.env.YUI_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yui-signals-'),
);
const S = require('./signals') as typeof import('./signals');
const R = require('./rules') as typeof import('./rules');
const { BASE_CATEGORIES } =
    require('./concierge') as typeof import('./concierge');

const m = (from: string, headers: Record<string, string> = {}) => ({
    id: 'x',
    from,
    subject: 's',
    headers,
    snippet: '',
});

async function run() {
    assert.deepStrictEqual(
        S.detectSignal(m('a@b.c', { 'List-Unsubscribe': '<x>' })),
        {
            signal: 'list-unsubscribe',
            category: 'newsletter',
        },
    );
    assert.deepStrictEqual(S.detectSignal(m('a@b.c', { 'list-id': 'foo' })), {
        signal: 'list-id',
        category: 'newsletter',
    });
    assert.deepStrictEqual(S.detectSignal(m('a@b.c', { Precedence: 'Bulk' })), {
        signal: 'precedence-bulk',
        category: 'notification',
    });
    assert.deepStrictEqual(
        S.detectSignal(m('a@b.c', { 'Auto-Submitted': 'auto-generated' })),
        {
            signal: 'auto-submitted',
            category: 'notification',
        },
    );
    assert.strictEqual(
        S.detectSignal(m('a@b.c', { 'Auto-Submitted': 'no' })),
        null,
    );
    assert.deepStrictEqual(S.detectSignal(m('"GitHub" <noreply@github.com>')), {
        signal: 'automated-sender',
        category: 'notification',
    });
    assert.strictEqual(S.detectSignal(m('"Marie" <marie@gmail.com>')), null);
    // ordre : List-Unsubscribe gagne sur l'expéditeur automatisé
    assert.strictEqual(
        S.detectSignal(m('noreply@x.io', { 'List-Unsubscribe': '<x>' }))!
            .category,
        'newsletter',
    );
    // garde-fous
    const NOW = 1;
    const confirmedAny = R.newRule({
        when: { from: 'noreply@github.com' },
        category: 'admin',
        origin: 'user',
        confirmed: true,
        now: NOW,
    });
    const perso = R.newRule({
        when: { from: 'github.com' },
        category: 'perso',
        origin: 'correction',
        confirmed: true,
        now: NOW,
    });
    const negative = R.newRule({
        when: { from: 'noreply@github.com' },
        category: null,
        origin: 'user',
        confirmed: true,
        now: NOW,
    });
    const unconfirmed = R.ruleFromSignal(
        'noreply@github.com',
        'notification',
        NOW,
    );
    assert.strictEqual(
        S.signalAllowed([confirmedAny], m('noreply@github.com')),
        false,
    );
    assert.strictEqual(
        S.signalAllowed([perso], m('noreply@github.com')),
        false,
    );
    assert.strictEqual(
        S.signalAllowed([negative], m('noreply@github.com')),
        false,
    );
    assert.strictEqual(
        S.signalAllowed([unconfirmed], m('noreply@github.com')),
        true,
    );
    assert.strictEqual(S.signalAllowed([], m('noreply@github.com')), true);
    const notif = BASE_CATEGORIES.find((c) => c.id === 'notification');
    assert.ok(notif && notif.archive && notif.label === 'Yui/Notifications');
    console.log('signals ok');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
