import assert from 'assert';
import { listTaskView, toTaskView, DEFAULT_LIMIT, MAX_LIMIT } from './taskView';

function task(over: Record<string, unknown>) {
    return {
        pk: 1,
        id: 'id-' + (over.title ?? 'x'),
        path: 'todos/x.md',
        project: null,
        title: 'Titre',
        state: 'todo',
        parentId: null,
        order: '2026-06-25',
        description: 'd'.repeat(1_000),
        priority: 'none',
        tags: [],
        createdAt: '2026-06-25',
        updatedAt: '2026-06-26',
        ...over,
    };
}

function run(): void {
    // projection : champs utiles seulement, pas de description par défaut
    const v = toTaskView(
        task({ title: 'A', project: 'yui', priority: 'high', tags: ['perso'] }),
    );
    assert.deepStrictEqual(v, {
        id: 'id-A',
        title: 'A',
        state: 'todo',
        project: 'yui',
        priority: 'high',
        tags: ['perso'],
    });

    // detail : description bornée à 400 caractères
    const d = toTaskView(task({ title: 'B' }), true);
    assert.ok(
        d.description &&
            d.description.length === 401 &&
            d.description.endsWith('…'),
    );

    // ouvertes par défaut, done/canceled exclues, en cours d'abord
    const all = [
        task({ title: 'done', state: 'done' }),
        task({ title: 'backlog', state: 'backlog' }),
        task({ title: 'todo1' }),
        task({ title: 'wip', state: 'in_progress' }),
        task({ title: 'canceled', state: 'canceled' }),
        task({ title: 'todo2' }),
    ];
    const open = listTaskView(all);
    assert.deepStrictEqual(
        open.tasks.map((t) => t.title),
        ['wip', 'todo1', 'todo2', 'backlog'],
    );
    assert.strictEqual(open.total, 4);
    assert.strictEqual(open.shown, 4);
    assert.strictEqual(open.hint, undefined);

    // filtre state explicite : les done deviennent visibles
    assert.deepStrictEqual(
        listTaskView(all, { state: 'done' }).tasks.map((t) => t.title),
        ['done'],
    );

    // filtre project
    const projects = [
        task({ title: 'y', project: 'yui' }),
        task({ title: 'k', project: 'koya' }),
    ];
    assert.deepStrictEqual(
        listTaskView(projects, { project: 'koya' }).tasks.map((t) => t.title),
        ['k'],
    );

    // limite par défaut + indice quand on coupe
    const many = Array.from({ length: 120 }, (_, i) =>
        task({ title: `t${i}` }),
    );
    const cut = listTaskView(many);
    assert.strictEqual(cut.shown, DEFAULT_LIMIT);
    assert.strictEqual(cut.total, 120);
    assert.ok(cut.hint && cut.hint.includes('80 tâche(s)'));
    assert.strictEqual(listTaskView(many, { limit: 1_000 }).shown, MAX_LIMIT);
    assert.strictEqual(listTaskView(many, { limit: 0 }).shown, DEFAULT_LIMIT);

    // la sortie compacte des 120 tâches reste petite
    assert.ok(JSON.stringify(cut).length < 6_000);

    console.log('taskView: all tests passed');
}

run();
