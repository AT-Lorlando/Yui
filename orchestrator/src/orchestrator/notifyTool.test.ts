import assert from 'assert';
import {
    getVirtualTools,
    handleVirtualTool,
    setSecretaryBriefProvider,
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

    console.log('All notifyTool tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
