import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
process.env.YUI_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yui-triage-'),
);
const T = require('./triage') as typeof import('./triage');
const R = require('./rules') as typeof import('./rules');

const VALID = new Set(['lire', 'newsletter', 'notification', 'admin', 'perso']);
const NOW = 1;
const m = (from: string, headers: Record<string, string> = {}) => ({
    id: 'x',
    from,
    subject: 's',
    headers,
    snippet: '',
});

async function run() {
    const userRule = R.newRule({
        when: { from: 'edf.fr' },
        category: 'admin',
        origin: 'user',
        confirmed: true,
        now: NOW,
    });
    assert.deepStrictEqual(
        T.deterministicVerdict(m('service@edf.fr'), [userRule], VALID),
        { category: 'admin', stage: 'rule', ruleId: userRule.id, final: true },
    );
    // règle confirmée vers une catégorie devenue inconnue → ignorée
    const stale = R.newRule({
        when: { from: 'edf.fr' },
        category: 'ghost',
        origin: 'user',
        confirmed: true,
        now: NOW,
    });
    assert.strictEqual(
        T.deterministicVerdict(
            m('service@edf.fr', { 'List-Unsubscribe': '<x>' }),
            [stale],
            VALID,
        )?.stage,
        'signal',
    );
    // règle négative → LLM même avec signal
    const neg = R.newRule({
        when: { from: 'noreply@github.com' },
        category: null,
        origin: 'user',
        confirmed: true,
        now: NOW,
    });
    assert.strictEqual(
        T.deterministicVerdict(m('noreply@github.com'), [neg], VALID),
        null,
    );
    // signal → provisoire, non final
    const v = T.deterministicVerdict(m('noreply@github.com'), [], VALID);
    assert.deepStrictEqual(v, {
        category: 'notification',
        stage: 'signal',
        signal: 'automated-sender',
        final: false,
    });
    // règle signal non confirmée existante → même verdict provisoire, ruleId porté
    const q = R.ruleFromSignal('noreply@github.com', 'notification', NOW);
    assert.deepStrictEqual(
        T.deterministicVerdict(m('noreply@github.com'), [q], VALID),
        {
            category: 'notification',
            stage: 'signal',
            ruleId: q.id,
            final: false,
        },
    );
    // rien → null
    assert.strictEqual(
        T.deterministicVerdict(m('marie@gmail.com'), [], VALID),
        null,
    );
    // plafond du lot
    const sixty = Array.from({ length: 60 }, (_, i) => i);
    const { now, later } = T.splitForLlm(sixty);
    assert.strictEqual(now.length, 24);
    assert.strictEqual(later.length, 36);
    assert.deepStrictEqual(T.fallbackVerdict(), {
        category: 'lire',
        stage: 'fallback',
        final: false,
    });
    console.log('triage ok');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
