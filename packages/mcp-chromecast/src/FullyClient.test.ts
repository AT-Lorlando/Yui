import assert from 'assert';
import { buildFullyUrl, FullyClient } from './FullyClient';

/** Fake fetch enregistrant les URLs appelées, renvoyant une réponse paramétrable. */
function fakeFetch(
    bodyFor: (url: string) => {
        ok?: boolean;
        status?: number;
        body?: string;
    } = () => ({}),
) {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
        calls.push(url);
        const r = bodyFor(url);
        return {
            ok: r.ok ?? true,
            status: r.status ?? 200,
            text: async () => r.body ?? '{"status":"OK"}',
        };
    };
    return { calls, fetchFn };
}

async function run(): Promise<void> {
    // ── buildFullyUrl : forme + encodage ───────────────────────────────────────
    {
        const url = buildFullyUrl('10.0.0.50', '2323', 'loadURL', 'secret', {
            url: 'http://10.0.0.1:3000/dashboard',
        });
        const u = new URL(url);
        assert.strictEqual(u.hostname, '10.0.0.50');
        assert.strictEqual(u.port, '2323');
        assert.strictEqual(u.searchParams.get('cmd'), 'loadURL');
        assert.strictEqual(u.searchParams.get('type'), 'json');
        assert.strictEqual(u.searchParams.get('password'), 'secret');
        // l'URL cible doit être préservée (encodée) telle quelle
        assert.strictEqual(
            u.searchParams.get('url'),
            'http://10.0.0.1:3000/dashboard',
        );
    }

    // ── pas de password → pas de param password ────────────────────────────────
    {
        const u = new URL(buildFullyUrl('1.2.3.4', '2323', 'screenOn', ''));
        assert.strictEqual(u.searchParams.has('password'), false);
    }

    // ── castDashboard : séquence screenOn → toForeground → loadURL ─────────────
    {
        const { calls, fetchFn } = fakeFetch();
        const client = new FullyClient(
            '10.0.0.50',
            '2323',
            'pw',
            fetchFn as any,
        );
        const msg = await client.castDashboard('http://srv:3000/dashboard');

        assert.strictEqual(calls.length, 3);
        assert.strictEqual(
            new URL(calls[0]).searchParams.get('cmd'),
            'screenOn',
        );
        assert.strictEqual(
            new URL(calls[1]).searchParams.get('cmd'),
            'toForeground',
        );
        const last = new URL(calls[2]);
        assert.strictEqual(last.searchParams.get('cmd'), 'loadURL');
        assert.strictEqual(
            last.searchParams.get('url'),
            'http://srv:3000/dashboard',
        );
        assert.ok(msg.includes('http://srv:3000/dashboard'));
    }

    // ── IP absente → erreur explicite (avant tout appel réseau) ────────────────
    {
        const { calls, fetchFn } = fakeFetch();
        const client = new FullyClient('', '2323', 'pw', fetchFn as any);
        await assert.rejects(
            () => client.castDashboard('http://x/dashboard'),
            /FULLY_IP non configuré/,
        );
        assert.strictEqual(calls.length, 0, 'aucun appel réseau sans IP');
    }

    // ── réponse Fully en erreur (mauvais mot de passe) → throw ─────────────────
    {
        const { fetchFn } = fakeFetch(() => ({
            body: '{"status":"Error","statustext":"Wrong password"}',
        }));
        const client = new FullyClient(
            '10.0.0.50',
            '2323',
            'bad',
            fetchFn as any,
        );
        await assert.rejects(
            () => client.castDashboard('http://x/dashboard'),
            /Wrong password/,
        );
    }

    console.log('All FullyClient tests passed');
}

run();
