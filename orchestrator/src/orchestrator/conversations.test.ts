import assert from 'assert';
import { ConversationManager } from './conversations';

function run(): void {
    const mgr = new ConversationManager({ saveStories: true });

    // voix : reset crée une nouvelle conversation
    const v1 = mgr.getOrCreateVoice(true);
    assert.strictEqual(v1.source, 'voice');
    // reset=false continue la même
    const v1bis = mgr.getOrCreateVoice(false);
    assert.strictEqual(v1bis.id, v1.id);
    // reset=true en crée une nouvelle (id différent)
    const v2 = mgr.getOrCreateVoice(true);
    assert.notStrictEqual(v2.id, v1.id);

    // app : sans id, crée une conversation app
    const a1 = mgr.getOrCreateApp();
    assert.strictEqual(a1.source, 'app');
    // avec l'id existant, continue la même
    const a1bis = mgr.getOrCreateApp(a1.id);
    assert.strictEqual(a1bis.id, a1.id);

    // touch ré-arme un timer sans throw
    mgr.touch(a1.id);

    // finalize retire la conversation du map (idempotent)
    mgr.finalize(a1.id);
    mgr.finalize(a1.id); // pas de throw au second appel
    assert.strictEqual(mgr.get(a1.id), undefined);

    // branche : nouvelle conversation app avec parentId
    const parent = mgr.getOrCreateApp();
    const branch = mgr.createBranch(parent.id);
    assert.notStrictEqual(branch.id, parent.id);
    assert.strictEqual(branch.story.parentId, parent.id);
    assert.strictEqual(branch.source, 'app');

    console.log('All conversations tests passed');
}

run();
