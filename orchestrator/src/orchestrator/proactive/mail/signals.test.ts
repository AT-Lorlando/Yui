import assert from 'assert';
import * as S from './signals';

const m = (from: string, headers: Record<string, string> = {}) => ({
    from,
    subject: 's',
    headers,
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
    // le sujet est facultatif
    assert.deepStrictEqual(
        S.detectSignal({ from: 'Alerts <ALERTS@bank.fr>', headers: {} }),
        { signal: 'automated-sender', category: 'notification' },
    );
    console.log('signals ok');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
