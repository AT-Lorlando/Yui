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

    console.log('All YojiClient core tests passed');
}

run();
