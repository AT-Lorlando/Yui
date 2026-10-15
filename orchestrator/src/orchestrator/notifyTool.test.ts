import assert from 'assert';
import {
    getVirtualTools,
    handleVirtualTool,
    setSecretaryBriefProvider,
    setWatchProvider,
} from './virtualTools';

// notify_user : le LLM peut pousser une notification FCM (le _notify des
// scènes reste un tool virtuel caché, réservé aux scènes/bindings).
async function run(): Promise<void> {
    const tools = getVirtualTools();
    const t = tools.find((x) => x.function.name === 'notify_user');
    assert.ok(t, 'notify_user doit être exposé au LLM');
    assert.deepStrictEqual((t!.function.parameters as any).required, [
        'message',
    ]);
    // speak_aloud : annonce sur l'enceinte, décidée par le LLM seulement sur
    // demande explicite (la réponse vocale normale est déjà lue).
    const sp = tools.find((x) => x.function.name === 'speak_aloud');
    assert.ok(sp, 'speak_aloud doit être exposé au LLM');
    assert.deepStrictEqual((sp!.function.parameters as any).required, ['text']);
    // Le tool interne des scènes ne doit PAS être exposé au LLM.
    assert.ok(
        !tools.some((x) => x.function.name === '_notify'),
        '_notify (scènes) ne doit pas apparaître côté LLM',
    );

    // secretary_brief : exposé au LLM, et sans provider câblé (moteur pas
    // encore initialisé au démarrage) répond un message plutôt que de planter.
    assert.ok(
        tools.some((x) => x.function.name === 'secretary_brief'),
        'secretary_brief doit être exposé au LLM',
    );
    const result = await handleVirtualTool({
        id: 'call-1',
        type: 'function',
        function: { name: 'secretary_brief', arguments: '{}' },
    } as any);
    assert.strictEqual(result?.content, "La secrétaire n'est pas disponible.");

    // Un provider qui rejette ne doit jamais faire échouer le tool call —
    // sinon tout le tour LLM (Promise.all des tool calls) plante avec lui.
    setSecretaryBriefProvider(async () => {
        throw new Error('proactive engine down');
    });
    const failing = await handleVirtualTool({
        id: 'call-2',
        type: 'function',
        function: { name: 'secretary_brief', arguments: '{}' },
    } as any);
    assert.ok(
        failing?.content.startsWith("La secrétaire n'a pas pu faire le point"),
        `contenu inattendu: ${failing?.content}`,
    );

    // watch_for remplace mail_watch : exposé au LLM (pas de x-audience).
    assert.ok(
        !tools.some((x) => x.function.name === 'mail_watch'),
        'mail_watch est retiré',
    );
    const wf = tools.find((x) => x.function.name === 'watch_for');
    assert.ok(wf, 'watch_for doit être exposé au LLM');
    const wfParams = wf!.function.parameters as any;
    assert.deepStrictEqual(wfParams.required, ['what', 'keywords']);
    assert.strictEqual(wfParams['x-audience'], undefined);
    assert.strictEqual(wfParams.properties.keywords.maxItems, 5);
    const watch = (args: Record<string, unknown>) =>
        handleVirtualTool({
            id: 'call-w',
            type: 'function',
            function: { name: 'watch_for', arguments: JSON.stringify(args) },
        } as any);
    const ok = { what: 'Réponse de Michel', keywords: ['Michel'] };
    assert.strictEqual(
        (await watch(ok))?.content,
        "La secrétaire n'est pas disponible.",
    );
    const calls: any[] = [];
    setWatchProvider(async (input) => {
        calls.push(input);
        return `ok ${input.days}`;
    });
    assert.strictEqual(
        (
            await watch({
                what: '  Réponse de Michel  ',
                keywords: [' Michel ', '', 'devis', 3],
            })
        )?.content,
        'ok 7',
    );
    assert.deepStrictEqual(
        calls[0],
        { what: 'Réponse de Michel', keywords: ['Michel', 'devis'], days: 7 },
        'texte et mots-clés nettoyés, défaut 7 j, pas de source',
    );
    await watch({ ...ok, days: 200 });
    await watch({ ...ok, days: 0 });
    await watch({ ...ok, days: 'abc' });
    await watch({ ...ok, days: 7.6 });
    assert.deepStrictEqual(
        calls.slice(1).map((c) => c.days),
        [60, 1, 7, 8],
        'jours bornés 1–60',
    );
    await watch({ ...ok, source: 'deliveries' });
    await watch({ ...ok, source: 'external:koya' });
    assert.deepStrictEqual(
        calls.slice(-2).map((c) => c.source),
        ['deliveries', 'external:koya'],
    );
    const n = calls.length;
    const short = await watch({ what: 'abc', keywords: ['x'] });
    const none = await watch({ what: 'Réponse de Michel' });
    const many = await watch({
        what: 'Réponse de Michel',
        keywords: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    const badSource = await watch({ ...ok, source: 'sms' });
    assert.strictEqual(calls.length, n, 'invalide : provider jamais appelé');
    assert.ok(short?.content.includes('5 et 300'), `${short?.content}`);
    for (const r of [none, many]) {
        assert.ok(
            r?.content.includes('mots-clés'),
            `message de validation attendu: ${r?.content}`,
        );
    }
    assert.ok(badSource?.content.includes('Source inconnue'));
    setWatchProvider(async () => {
        throw new Error("Trop d'attentes actives (maximum 40)");
    });
    const err = await watch(ok);
    assert.ok(
        err?.content.includes("Trop d'attentes actives"),
        `erreur relayée au LLM: ${err?.content}`,
    );

    console.log('All notifyTool tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
