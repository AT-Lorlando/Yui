import assert from 'assert';
import {
    getVirtualTools,
    handleVirtualTool,
    setSecretaryBriefProvider,
    setMailWatchProvider,
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

    // mail_watch : exposé au LLM (pas de x-audience), texte requis.
    const mw = tools.find((x) => x.function.name === 'mail_watch');
    assert.ok(mw, 'mail_watch doit être exposé au LLM');
    const mwParams = mw!.function.parameters as any;
    assert.deepStrictEqual(mwParams.required, ['text']);
    assert.strictEqual(mwParams['x-audience'], undefined);
    const watch = (args: Record<string, unknown>) =>
        handleVirtualTool({
            id: 'call-w',
            type: 'function',
            function: { name: 'mail_watch', arguments: JSON.stringify(args) },
        } as any);
    assert.strictEqual(
        (await watch({ text: 'Réponse de Michel' }))?.content,
        "La secrétaire n'est pas disponible.",
    );
    const calls: Array<[string, number]> = [];
    setMailWatchProvider(async (text, days) => {
        calls.push([text, days]);
        return `ok ${days}`;
    });
    assert.strictEqual(
        (await watch({ text: '  Réponse de Michel  ' }))?.content,
        'ok 14',
    );
    assert.deepStrictEqual(calls[0], ['Réponse de Michel', 14], 'défaut 14 j');
    await watch({ text: 'Offre DevOps', days: 200 });
    await watch({ text: 'Offre DevOps', days: 0 });
    await watch({ text: 'Offre DevOps', days: 'abc' });
    await watch({ text: 'Offre DevOps', days: 7.6 });
    assert.deepStrictEqual(
        calls.slice(1).map((c) => c[1]),
        [60, 1, 14, 8],
        'jours bornés 1–60',
    );
    const n = calls.length;
    const short = await watch({ text: 'abc' });
    const long = await watch({ text: 'x'.repeat(301) });
    const none = await watch({});
    assert.strictEqual(
        calls.length,
        n,
        'texte invalide : provider jamais appelé',
    );
    for (const r of [short, long, none]) {
        assert.ok(
            r?.content.includes('5 et 300'),
            `message de validation attendu: ${r?.content}`,
        );
    }
    setMailWatchProvider(async () => {
        throw new Error("Trop d'ordres actifs (maximum 40)");
    });
    const err = await watch({ text: 'Réponse de Michel' });
    assert.ok(
        err?.content.includes("Trop d'ordres actifs"),
        `erreur relayée au LLM: ${err?.content}`,
    );

    console.log('All notifyTool tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
