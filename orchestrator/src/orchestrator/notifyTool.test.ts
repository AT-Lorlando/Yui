import assert from 'assert';
import { getVirtualTools } from './virtualTools';

// notify_user : le LLM peut pousser une notification FCM (le _notify des
// scènes reste un tool virtuel caché, réservé aux scènes/bindings).
function run(): void {
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
    console.log('All notifyTool tests passed');
}

run();
