import assert from 'assert';
import { YOJI_TOOLS } from './tools';

function run(): void {
    const names = YOJI_TOOLS.map((t) => t.name);

    // exact tool set
    assert.deepStrictEqual(names.sort(), [
        'create_folder',
        'create_note',
        'create_postit',
        'create_task',
        'create_todo_project',
        'delete_note',
        'delete_task',
        'delete_todo_project',
        'get_note',
        'list_folders',
        'list_notes',
        'list_postits',
        'list_tasks',
        'list_todo_projects',
        'move_note',
        'search_notes',
        'sync_vault',
        'update_note',
        'update_task',
    ]);

    // every tool has a description and an object input schema
    for (const t of YOJI_TOOLS) {
        assert.ok(t.description && t.description.length > 0, `${t.name} desc`);
        assert.strictEqual(
            (t.inputSchema as any).type,
            'object',
            `${t.name} schema`,
        );
    }

    // create_task requires title; state/priority constrained by enum
    const createTask = YOJI_TOOLS.find((t) => t.name === 'create_task')!;
    assert.deepStrictEqual((createTask.inputSchema as any).required, ['title']);
    assert.deepStrictEqual(
        (createTask.inputSchema as any).properties.state.enum,
        ['backlog', 'todo', 'in_progress', 'done', 'canceled'],
    );
    assert.deepStrictEqual(
        (createTask.inputSchema as any).properties.priority.enum,
        ['none', 'low', 'medium', 'high', 'urgent'],
    );

    // create_postit: title borné 1-120, tags borné à 5
    const createPostit = YOJI_TOOLS.find((t) => t.name === 'create_postit')!;
    assert.deepStrictEqual((createPostit.inputSchema as any).required, [
        'title',
    ]);
    assert.strictEqual(
        (createPostit.inputSchema as any).properties.title.minLength,
        1,
    );
    assert.strictEqual(
        (createPostit.inputSchema as any).properties.title.maxLength,
        120,
    );
    assert.strictEqual(
        (createPostit.inputSchema as any).properties.tags.maxItems,
        5,
    );

    console.log('All tools tests passed');
}

run();
