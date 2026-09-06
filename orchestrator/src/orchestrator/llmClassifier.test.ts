import assert from 'assert';
import {
    classifyOrder,
    fastPathCategory,
    isComplexOrder,
} from './llmClassifier';

// Faux client OpenAI : renvoie un contenu piloté par le test.
function fakeClient(content: string | null, callLog: string[] = []) {
    return {
        chat: {
            completions: {
                create: async (params: { messages: { content: string }[] }) => {
                    callLog.push(params.messages[1]?.content ?? '');
                    if (content === null) throw new Error('LLM down');
                    return { choices: [{ message: { content } }] };
                },
            },
        },
    } as never;
}

async function run(): Promise<void> {
    // Heuristique de repli (inchangée)
    assert.strictEqual(isComplexOrder('éteins le salon'), false);
    assert.strictEqual(isComplexOrder('résume mes mails du jour'), true);
    assert.strictEqual(isComplexOrder('a'.repeat(200)), true);

    // Chemin court : domotique évidente (mots-clés serverGroups) → 0 LLM
    assert.strictEqual(fastPathCategory('éteins le salon'), 'domotique');
    assert.strictEqual(fastPathCategory('mets du lofi'), 'domotique');
    assert.strictEqual(
        fastPathCategory('lance un timer de 10 minutes'),
        'domotique',
    );
    // Mot « intelligent » ou multi-étapes → pas de chemin court
    assert.strictEqual(fastPathCategory('explique-moi les lumières'), null);
    assert.strictEqual(
        fastPathCategory(
            'éteins le salon puis lance la télé ensuite la musique',
        ),
        null,
    );
    // Rien de domotique → pas de chemin court
    assert.strictEqual(fastPathCategory('raconte-moi une blague'), null);

    // Chemin court : le LLM n'est jamais appelé
    {
        const calls: string[] = [];
        const c = await classifyOrder(
            'allume la chambre',
            fakeClient('{"c":"complexe"}', calls),
            'm',
        );
        assert.deepStrictEqual(c, {
            category: 'domotique',
            source: 'fast-path',
        });
        assert.strictEqual(calls.length, 0, 'pas d’appel LLM en chemin court');
    }

    // LLM éclair : verdict JSON respecté
    {
        const c = await classifyOrder(
            'raconte-moi une blague',
            fakeClient('{"c":"conversation"}'),
            'm',
        );
        assert.deepStrictEqual(c, { category: 'conversation', source: 'llm' });
    }
    {
        const c = await classifyOrder(
            'organise mon déménagement avec mon agenda',
            fakeClient('Voilà : {"c":"complexe"} !'),
            'm',
        );
        assert.strictEqual(c.category, 'complexe');
        assert.strictEqual(c.source, 'llm');
    }

    // JSON invalide ou LLM down → heuristique
    {
        const c = await classifyOrder(
            'résume mes mails',
            fakeClient('euh je sais pas'),
            'm',
        );
        assert.deepStrictEqual(c, {
            category: 'complexe',
            source: 'heuristic',
        });
    }
    {
        const c = await classifyOrder(
            'raconte-moi ta journée',
            fakeClient(null),
            'm',
        );
        assert.deepStrictEqual(c, {
            category: 'conversation',
            source: 'heuristic',
        });
    }

    console.log('All llmClassifier tests passed');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
