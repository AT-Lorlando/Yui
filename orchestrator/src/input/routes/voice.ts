// Voix pour l'app (dictée + mode appel) — monté sur /voice, Bearer par route.
//
// POST /voice/transcribe : corps brut `application/octet-stream` = PCM int16
//   16 kHz mono (≤ 2 Mo ≈ 60 s) → relayé au serveur voix (`POST /transcribe`
//   à côté de /speak, même Whisper que le micro du Pi) → {text, seconds}.
// POST /voice/tts {text} : WAV XTTS de la phrase (voix de Yui) → audio/wav.
import express from 'express';
import Logger from '../../logger';
import { SPEAK_PIPELINE_URL } from '../../orchestrator/notify';
import { synthesizeWav } from '../ttsClient';
import type { RequireAuth } from './helpers';

// Même serveur que /speak (SPEAK_PIPELINE_URL / SPEAK_PORT, notify.ts) sauf override.
export const TRANSCRIBE_URL =
    process.env.VOICE_TRANSCRIBE_URL ??
    SPEAK_PIPELINE_URL.replace(/\/speak\/?$/, '/transcribe');
export const TRANSCRIBE_MAX_BYTES = 2 * 1024 * 1024;
export const TTS_MAX_CHARS = 600;

export interface VoiceDeps {
    fetchImpl?: typeof fetch;
    synthesize?: (text: string) => Promise<Buffer | null>;
}

export function voiceRoutes(
    requireAuth: RequireAuth,
    deps: VoiceDeps = {},
): express.Router {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const synthesize =
        deps.synthesize ?? ((text: string) => synthesizeWav(text, fetchImpl));
    const r = express.Router();

    r.post(
        '/transcribe',
        requireAuth,
        express.raw({
            type: () => true,
            limit: TRANSCRIBE_MAX_BYTES,
        }),
        async (req: any, res: any) => {
            const body: Buffer | undefined = Buffer.isBuffer(req.body)
                ? req.body
                : undefined;
            if (!body || body.length === 0 || body.length % 2 !== 0) {
                return res
                    .status(400)
                    .json({ error: 'body must be int16 PCM, 16 kHz mono' });
            }
            try {
                const up = await fetchImpl(TRANSCRIBE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: new Uint8Array(body),
                    signal: AbortSignal.timeout(30_000),
                });
                const text = await up.text();
                if (!up.ok) {
                    Logger.warn(
                        `[voice] transcribe upstream ${up.status}: ${text.slice(
                            0,
                            200,
                        )}`,
                    );
                    return res
                        .status(up.status === 503 ? 503 : 502)
                        .json({ error: `transcription failed (${up.status})` });
                }
                res.type('application/json').send(text);
            } catch (e: any) {
                Logger.warn(
                    `[voice] transcribe unreachable: ${e?.message ?? e}`,
                );
                res.status(503).json({ error: 'voice server unreachable' });
            }
        },
    );

    r.post('/tts', requireAuth, async (req: any, res: any) => {
        const text = String(req.body?.text ?? '').trim();
        if (!text) return res.status(400).json({ error: 'text is required' });
        if (text.length > TTS_MAX_CHARS) {
            return res
                .status(413)
                .json({ error: `text longer than ${TTS_MAX_CHARS} chars` });
        }
        const wav = await synthesize(text);
        if (!wav) return res.status(503).json({ error: 'tts unavailable' });
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.send(wav);
    });

    return r;
}
