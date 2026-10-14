import assert from 'assert';
import {
    capToolResult,
    fitMessagesToBudget,
    contextBudgetChars,
    messageChars,
} from './contextBudget';

function run(): void {
    // capToolResult — sous le plafond : intact
    assert.strictEqual(capToolResult('hello', 100), 'hello');

    // tableau JSON : garde les premiers éléments, note explicite
    const items = Array.from({ length: 200 }, (_, i) => ({
        id: i,
        title: `Tâche numéro ${i}`,
        description: 'x'.repeat(50),
    }));
    const capped = capToolResult(JSON.stringify(items, null, 2), 2_000);
    assert.ok(capped.length <= 2_000, `capped ${capped.length}`);
    const firstLine = capped.split('\n')[0];
    const kept = JSON.parse(firstLine);
    assert.ok(Array.isArray(kept) && kept.length > 5 && kept.length < 200);
    assert.strictEqual(kept[0].id, 0);
    assert.ok(capped.includes(`${kept.length} éléments affichés sur 200`));

    // texte libre : tronqué avec le total
    const text = capToolResult('a'.repeat(5_000), 1_000);
    assert.ok(text.length <= 1_000);
    assert.ok(text.includes('5000 caractères au total'));

    // objet JSON (pas un tableau) : traité comme du texte
    const obj = capToolResult(JSON.stringify({ big: 'b'.repeat(3_000) }), 500);
    assert.ok(obj.length <= 500 && obj.includes('tronqué'));

    // premier élément déjà trop gros → repli texte
    const huge = capToolResult(JSON.stringify([{ b: 'c'.repeat(3_000) }]), 500);
    assert.ok(huge.length <= 500 && huge.includes('tronqué'));

    // fitMessagesToBudget — rien à faire sous le budget
    const msgs: any[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'avant' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'ordre' },
        { role: 'assistant', content: null, tool_calls: [{ id: '1' }] },
        { role: 'tool', tool_call_id: '1', content: 'r'.repeat(5_000) },
        { role: 'tool', tool_call_id: '2', content: 's'.repeat(2_000) },
    ];
    const noop = fitMessagesToBudget(msgs, {
        baseChars: 0,
        protectedFrom: 3,
        budgetChars: 100_000,
    });
    assert.deepStrictEqual(noop.actions, []);
    assert.strictEqual(msgs.length, 7);

    // au-dessus : le plus gros résultat d'outil est écourté en premier
    const r1 = fitMessagesToBudget(msgs, {
        baseChars: 0,
        protectedFrom: 3,
        budgetChars: 3_500,
    });
    assert.ok(r1.actions[0].startsWith('tool result 5000'), r1.actions[0]);
    assert.ok((msgs[5].content as string).startsWith('rrr'));
    assert.ok((msgs[5].content as string).includes('écourté'));
    assert.ok(r1.after <= 3_500, `after ${r1.after}`);
    assert.strictEqual(msgs.length, 7, 'historique conservé quand ça suffit');

    // encore trop : l'historique part du plus ancien, l'ordre courant reste
    const r2 = fitMessagesToBudget(msgs, {
        baseChars: 0,
        protectedFrom: 3,
        budgetChars: 700,
    });
    assert.ok(r2.actions.some((a) => a.startsWith('dropped history user')));
    assert.strictEqual(msgs[0].role, 'system');
    assert.ok(msgs.some((m) => m.role === 'user' && m.content === 'ordre'));
    assert.ok(!msgs.some((m) => m.content === 'avant'));

    // le prompt système et l'ordre courant ne sont jamais sacrifiés
    const stuck: any[] = [
        { role: 'system', content: 'x'.repeat(1_000) },
        { role: 'user', content: 'ordre' },
    ];
    const r3 = fitMessagesToBudget(stuck, {
        baseChars: 0,
        protectedFrom: 1,
        budgetChars: 100,
    });
    assert.deepStrictEqual(r3.actions, []);
    assert.strictEqual(stuck.length, 2);

    // budget par défaut : (65536 − réserve) × 3
    assert.strictEqual(contextBudgetChars(65_536), (65_536 - 6_144) * 3);
    assert.ok(messageChars({ role: 'user', content: 'abc' }) > 3);

    console.log('contextBudget: all tests passed');
}

run();
