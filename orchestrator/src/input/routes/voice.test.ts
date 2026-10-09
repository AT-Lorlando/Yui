import assert from 'assert';
import express from 'express';
import http from 'http';
import { voiceRoutes, TRANSCRIBE_URL, TTS_MAX_CHARS } from './voice';

process.on('unhandledRejection', () => {
    console.error('unhandled rejection');
    process.exit(1);
});

async function listen(app: express.Express): Promise<{
    port: number;
    close: () => void;
}> {
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    return {
        port: (server.address() as any).port,
        close: () => server.close(),
    };
}

const requireAuth = (req: any, res: any, next: any) =>
    req.headers.authorization === 'Bearer t'
        ? next()
        : res.status(401).json({ error: 'unauthorized' });

async function run(): Promise<void> {
    const upstream: { url: string; bytes: number; type: string }[] = [];
    let upstreamStatus = 200;
    const fetchImpl: typeof fetch = async (url: any, init: any) => {
        const body = init?.body as Uint8Array;
        upstream.push({
            url: String(url),
            bytes: body?.byteLength ?? 0,
            type: String(init?.headers?.['Content-Type'] ?? ''),
        });
        return new Response(
            upstreamStatus === 200
                ? JSON.stringify({ text: 'allume le salon', seconds: 1.5 })
                : JSON.stringify({ error: 'nope' }),
            { status: upstreamStatus },
        );
    };
    const synthesized: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(
        '/voice',
        voiceRoutes(requireAuth as any, {
            fetchImpl,
            synthesize: async (text) => {
                synthesized.push(text);
                return text === 'KO' ? null : Buffer.from('RIFFwav');
            },
        }),
    );
    const srv = await listen(app);
    const base = `http://127.0.0.1:${srv.port}/voice`;
    const pcm = new Uint8Array(16000 * 2); // 0,5 s de silence

    // ── /transcribe ──
    let r = await fetch(`${base}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm,
    });
    assert.strictEqual(r.status, 401, 'transcribe sans Bearer → 401');

    r = await fetch(`${base}/transcribe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            Authorization: 'Bearer t',
        },
        body: pcm,
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), {
        text: 'allume le salon',
        seconds: 1.5,
    });
    assert.strictEqual(upstream.length, 1);
    assert.strictEqual(upstream[0].url, TRANSCRIBE_URL);
    assert.strictEqual(
        upstream[0].bytes,
        pcm.byteLength,
        'PCM relayé tel quel',
    );
    assert.strictEqual(upstream[0].type, 'application/octet-stream');

    r = await fetch(`${base}/transcribe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            Authorization: 'Bearer t',
        },
        body: new Uint8Array(3),
    });
    assert.strictEqual(r.status, 400, 'nombre d’octets impair → 400');

    r = await fetch(`${base}/transcribe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            Authorization: 'Bearer t',
        },
        body: new Uint8Array(0),
    });
    assert.strictEqual(r.status, 400, 'corps vide → 400');

    upstreamStatus = 503;
    r = await fetch(`${base}/transcribe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/octet-stream',
            Authorization: 'Bearer t',
        },
        body: pcm,
    });
    assert.strictEqual(r.status, 503, 'Whisper pas prêt → 503');

    // ── /tts ──
    r = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer t',
        },
        body: JSON.stringify({ text: '  Bonjour Jérémy.  ' }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'audio/wav');
    assert.strictEqual(
        Buffer.from(await r.arrayBuffer()).toString(),
        'RIFFwav',
    );
    assert.deepStrictEqual(synthesized, ['Bonjour Jérémy.'], 'texte trimé');

    r = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer t',
        },
        body: JSON.stringify({ text: '' }),
    });
    assert.strictEqual(r.status, 400, 'texte vide → 400');

    r = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer t',
        },
        body: JSON.stringify({ text: 'x'.repeat(TTS_MAX_CHARS + 1) }),
    });
    assert.strictEqual(r.status, 413, 'texte trop long → 413');

    r = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer t',
        },
        body: JSON.stringify({ text: 'KO' }),
    });
    assert.strictEqual(r.status, 503, 'XTTS KO → 503');

    r = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x' }),
    });
    assert.strictEqual(r.status, 401, 'tts sans Bearer → 401');

    srv.close();
    console.log('voice routes: ok');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
