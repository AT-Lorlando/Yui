import assert from 'assert';
import { YojiClient } from './YojiClient';

/** Build a fake fetch that records the call and returns a canned Response. */
function fakeFetch(response: { status?: number; body?: unknown }) {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchFn = async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        const status = response.status ?? 200;
        const body =
            response.body === undefined ? '' : JSON.stringify(response.body);
        return new Response(status === 204 ? null : body, { status });
    };
    return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

async function run(): Promise<void> {
    // encodePath: slashes become %2F, each segment URL-encoded
    {
        const c = new YojiClient({ baseUrl: 'http://x/api/v1' });
        assert.strictEqual(c.encodePath('inbox/idea.md'), 'inbox%2Fidea.md');
        assert.strictEqual(
            c.encodePath('todos/My Project'),
            'todos%2FMy%20Project',
        );
        assert.strictEqual(c.encodePath('note é.md'), 'note%20%C3%A9.md');
    }

    // request: builds URL from base, sends Authorization when apiKey set
    {
        const { calls, fetchFn } = fakeFetch({ body: [{ path: 'a.md' }] });
        const c = new YojiClient({
            baseUrl: 'http://x/api/v1/',
            apiKey: 'secret',
            fetchFn,
        });
        const out = await c.listNotes();
        assert.strictEqual(calls[0].url, 'http://x/api/v1/notes');
        assert.strictEqual(
            calls[0].init.headers['Authorization'],
            'Bearer secret',
        );
        assert.deepStrictEqual(out, [{ path: 'a.md' }]);
    }

    // request: maps HTTP error using {message}
    {
        const { fetchFn } = fakeFetch({
            status: 404,
            body: { message: 'Note not found' },
        });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await assert.rejects(
            () => c.getNote('missing.md'),
            /HTTP 404: Note not found/,
        );
    }

    // request: maps HTTP error using {error}
    {
        const { fetchFn } = fakeFetch({
            status: 401,
            body: { error: 'Invalid or missing API key' },
        });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await assert.rejects(
            () => c.listNotes(),
            /HTTP 401: Invalid or missing API key/,
        );
    }

    // request: 204 returns undefined, no JSON parse
    {
        const { fetchFn } = fakeFetch({ status: 204 });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        const out = await c.deleteNote('a.md');
        assert.strictEqual(out, undefined);
    }

    // createNote: POST /notes with {path, content}
    {
        const { calls, fetchFn } = fakeFetch({ body: { path: 'a.md' } });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await c.createNote('inbox/a.md', 'hello');
        assert.strictEqual(calls[0].url, 'http://x/api/v1/notes');
        assert.strictEqual(calls[0].init.method, 'POST');
        assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
            path: 'inbox/a.md',
            content: 'hello',
        });
    }

    // updateNote: PUT /notes/{encoded} with {content}
    {
        const { calls, fetchFn } = fakeFetch({ body: { path: 'a.md' } });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await c.updateNote('inbox/a.md', 'new');
        assert.strictEqual(calls[0].url, 'http://x/api/v1/notes/inbox%2Fa.md');
        assert.strictEqual(calls[0].init.method, 'PUT');
        assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
            content: 'new',
        });
    }

    // searchNotes: GET /search?q=<encoded>
    {
        const { calls, fetchFn } = fakeFetch({ body: [] });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await c.searchNotes('todo list');
        assert.strictEqual(
            calls[0].url,
            'http://x/api/v1/search?q=todo%20list',
        );
    }

    // moveNote: POST /notes/move with {from, to}
    {
        const { calls, fetchFn } = fakeFetch({ body: {} });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await c.moveNote('a.md', 'archive/a.md');
        assert.strictEqual(calls[0].url, 'http://x/api/v1/notes/move');
        assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
            from: 'a.md',
            to: 'archive/a.md',
        });
    }

    // listTasks: filters by state and project client-side
    {
        const { fetchFn } = fakeFetch({
            body: [
                { id: '1', state: 'todo', project: 'todos/Work' },
                { id: '2', state: 'done', project: 'todos/Work' },
                { id: '3', state: 'todo', project: 'todos/Home' },
            ],
        });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        const out = await c.listTasks({ state: 'todo', project: 'todos/Work' });
        assert.deepStrictEqual(
            out.map((t: any) => t.id),
            ['1'],
        );
    }

    // listTasks: no filter returns all
    {
        const { calls, fetchFn } = fakeFetch({
            body: [{ id: '1' }, { id: '2' }],
        });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        const out = await c.listTasks();
        assert.strictEqual(calls[0].url, 'http://x/api/v1/todos');
        assert.strictEqual(out.length, 2);
    }

    // createTask: POST /todos, undefined fields dropped
    {
        const { calls, fetchFn } = fakeFetch({ body: { id: '9' } });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await c.createTask({ title: 'Buy milk', priority: 'high' });
        assert.strictEqual(calls[0].url, 'http://x/api/v1/todos');
        assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
            title: 'Buy milk',
            priority: 'high',
        });
    }

    // updateTask: PUT /todos/{id}
    {
        const { calls, fetchFn } = fakeFetch({ body: { id: '9' } });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await c.updateTask('9', { state: 'done' });
        assert.strictEqual(calls[0].url, 'http://x/api/v1/todos/9');
        assert.strictEqual(calls[0].init.method, 'PUT');
        assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
            state: 'done',
        });
    }

    // deleteProject: DELETE /todos/projects/{encoded}
    {
        const { calls, fetchFn } = fakeFetch({ status: 204 });
        const c = new YojiClient({ baseUrl: 'http://x/api/v1', fetchFn });
        await c.deleteProject('todos/Work');
        assert.strictEqual(
            calls[0].url,
            'http://x/api/v1/todos/projects/todos%2FWork',
        );
        assert.strictEqual(calls[0].init.method, 'DELETE');
    }

    console.log('All YojiClient core tests passed');
}

run();
