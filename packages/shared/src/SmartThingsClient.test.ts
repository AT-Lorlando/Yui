import assert from 'assert';
import {
    SmartThingsClient,
    TvOfflineError,
    HttpTransport,
} from './SmartThingsClient';

function fakeTransport() {
    const calls: any[] = [];
    const transport: HttpTransport = {
        async post(url, body, headers) {
            calls.push({ method: 'post', url, body, headers });
            return {
                status: 200,
                data: { results: [{ status: 'COMPLETED' }] },
            };
        },
        async get(url, headers) {
            calls.push({ method: 'get', url, headers });
            if (url.endsWith('/health'))
                return { status: 200, data: { state: 'ONLINE' } };
            return { status: 200, data: { components: {} } };
        },
    };
    return { calls, transport };
}

async function run() {
    // sendCommands → POST sur la bonne URL avec le bon body + Bearer
    {
        const { calls, transport } = fakeTransport();
        const c = new SmartThingsClient('DEV', async () => 'TOK', transport);
        await c.sendCommands([
            {
                component: 'main',
                capability: 'audioVolume',
                command: 'setVolume',
                arguments: [12],
            },
        ]);
        const call = calls[0];
        assert.ok(call.url.endsWith('/devices/DEV/commands'));
        assert.deepStrictEqual(call.body, {
            commands: [
                {
                    component: 'main',
                    capability: 'audioVolume',
                    command: 'setVolume',
                    arguments: [12],
                },
            ],
        });
        assert.strictEqual(call.headers.Authorization, 'Bearer TOK');
    }
    // getHealth → parse state
    {
        const { transport } = fakeTransport();
        const c = new SmartThingsClient('DEV', async () => 'TOK', transport);
        assert.strictEqual(await c.getHealth(), 'ONLINE');
    }
    // translate : ConflictError → TvOfflineError
    {
        const err = SmartThingsClient.translate({
            response: {
                status: 409,
                data: { error: { code: 'ConflictError' } },
            },
        });
        assert.ok(err instanceof TvOfflineError);
    }
    // translate : autre erreur → Error normale
    {
        const err = SmartThingsClient.translate(new Error('boom'));
        assert.ok(!(err instanceof TvOfflineError));
        assert.strictEqual(err.message, 'boom');
    }
    // translate : HTTP 409 sans code → TvOfflineError aussi
    {
        const err = SmartThingsClient.translate({
            response: { status: 409, data: {} },
        });
        assert.ok(err instanceof TvOfflineError);
    }
    console.log('All SmartThingsClient tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
