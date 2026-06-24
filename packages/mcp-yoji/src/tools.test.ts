import assert from 'assert';
import { YOJI_TOOLS } from './tools';

function run(): void {
    const names = YOJI_TOOLS.map((t) => t.name);

    // exact tool set
    assert.deepStrictEqual(names.sort(), [
        'create_folder',
        'create_note',
        'create_project',
        'create_task',
        'delete_note',
        'delete_project',
        'delete_task',
        'get_note',
        'list_folders',
        'list_notes',
        'list_projects',
        'list_tasks',
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

    console.log('All tools tests passed');
}

run();
