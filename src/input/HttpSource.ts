import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import cors from 'cors';
import * as http from 'http';
import Logger from '../logger';
import env from '../env';
import {
    InputSource,
    StreamHandler,
    StatusHandler,
    DeviceHandler,
    ScenesHandler,
    ToolsHandler,
} from './InputSource';

// ── TTS helper ────────────────────────────────────────────────────────────────
// Calls the XTTS server to synthesise text and returns WAV audio as base64.
// Returns null if the server is not available — caller degrades gracefully.

const TTS_SERVER_URL =
    process.env.TTS_SERVER_URL ?? 'http://localhost:18770/tts';
const TTS_SPEAKER = process.env.XTTS_SPEAKER ?? 'Lilya Stainthorpe';
const TTS_SPEED = parseFloat(process.env.XTTS_SPEED ?? '1.0');

async function generateTtsAudio(
    text: string,
): Promise<{ base64: string; mime: string } | null> {
    try {
        const res = await fetch(TTS_SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                language: 'fr',
                speaker: TTS_SPEAKER,
                speed: TTS_SPEED,
            }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return { base64: buf.toString('base64'), mime: 'audio/wav' };
    } catch {
        return null;
    }
}

export class HttpSource implements InputSource {
    private server: http.Server | null = null;

    private checkPassword(bearer: string | undefined, ip: string): boolean {
        if (bearer === undefined || bearer !== env.BEARER_TOKEN) {
            Logger.error('Wrong password');
            Logger.error(`Banned IP: ${ip}`);
            fs.appendFileSync('banned_ips.txt', `${ip}\n`);
            return false;
        }
        return true;
    }

    async start(
        handler: (order: string, reset?: boolean) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
        deviceHandler?: DeviceHandler,
        scenesHandler?: ScenesHandler,
        toolsHandler?: ToolsHandler,
    ): Promise<void> {
        const port = 3000;
        const app = express();
        app.use(cors({ origin: '*' }));
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));

        app.get('/health', (_req: any, res: any) => {
            res.status(200).json({ status: 'ok' });
        });

        // ── MCP status (used by dashboard, no auth — internal only) ───────────
        if (statusHandler) {
            app.get('/status', (_req: any, res: any) => {
                res.json(statusHandler());
            });
        }

        // ── MCP tools list (no auth — internal only) ──────────────────────────
        if (toolsHandler) {
            app.get('/tools', (_req: any, res: any) => {
                res.json(toolsHandler.list());
            });

            // Call a tool directly (bypasses LLM) — requires auth
            app.post('/tools/:name', async (req: any, res: any) => {
                const bearer = req.headers['authorization']?.split(' ')[1];
                if (!this.checkPassword(bearer, req.ip)) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }
                try {
                    const result = await toolsHandler.call(
                        req.params.name,
                        req.body || {},
                    );
                    return res.json({ result });
                } catch (e: any) {
                    return res.status(500).json({ error: e.message });
                }
            });
        }

        // ── Blocking endpoint (used by mobile app, cron, etc.) ───────────────
        // If the request body contains `audio: true`, the response includes
        // TTS audio as base64 WAV so the caller can play it locally.
        // The voice pipeline sends `voice: true` (not `audio: true`) and handles
        // its own TTS — it never receives audio bytes here.
        app.post('/order', async (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const order = req.body?.order;
            if (!order || typeof order !== 'string') {
                return res.status(400).json({ error: 'Missing "order" field' });
            }

            const wantsAudio = req.body?.audio === true;
            const reset = req.body?.reset === true;

            try {
                const result = await handler(order, reset);
                const response: Record<string, unknown> = { response: result };

                if (wantsAudio) {
                    const tts = await generateTtsAudio(result);
                    if (tts) {
                        response.audio = tts.base64;
                        response.audioMime = tts.mime;
                    }
                }

                return res.status(200).json(response);
            } catch (error) {
                Logger.error(`HTTP order error: ${error}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        // ── Streaming SSE endpoint (used by voice pipeline) ───────────────────
        // Returns tokens via Server-Sent Events as the LLM generates them.
        // Each event: data: {"token":"..."}\n\n
        // End signal:  data: [DONE]\n\n
        if (streamHandler) {
            app.post('/order/stream', async (req: any, res: any) => {
                const bearer = req.headers['authorization']?.split(' ')[1];
                if (!this.checkPassword(bearer, req.ip)) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }

                const order = req.body?.order;
                if (!order || typeof order !== 'string') {
                    return res
                        .status(400)
                        .json({ error: 'Missing "order" field' });
                }

                // Voice pipeline sends "voice: true" → cap response length
                const isVoice = req.body?.voice === true;
                const reset = req.body?.reset === true;

                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                try {
                    for await (const token of streamHandler(
                        order,
                        undefined,
                        reset,
                    )) {
                        res.write(`data: ${JSON.stringify({ token })}\n\n`);
                    }
                } catch (error) {
                    Logger.error(`SSE stream error: ${error}`);
                    res.write(
                        `data: ${JSON.stringify({ error: String(error) })}\n\n`,
                    );
                } finally {
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
            });
        }

        // ── Direct device control (bypasses LLM) ─────────────────────────────
        if (deviceHandler) {
            const dev = express.Router();

            // Auth middleware for all /devices routes
            dev.use((req: any, res: any, next: any) => {
                const bearer = req.headers['authorization']?.split(' ')[1];
                if (!this.checkPassword(bearer, req.ip)) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }
                next();
            });

            const call =
                (tool: string, args: Record<string, unknown> = {}) =>
                async (_req: any, res: any) => {
                    try {
                        res.json(await deviceHandler(tool, args));
                    } catch (e: any) {
                        res.status(500).json({ error: e.message });
                    }
                };

            // ── Lights ────────────────────────────────────────────────────────
            dev.get('/lights', call('list_lights'));
            dev.post('/lights/:id/on', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('turn_on_light', {
                            lightId: +req.params.id,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.post('/lights/:id/off', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('turn_off_light', {
                            lightId: +req.params.id,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.patch('/lights/:id/brightness', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('set_brightness', {
                            lightId: +req.params.id,
                            brightness: +req.body.brightness,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.patch('/lights/:id/color', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('set_color', {
                            lightId: +req.params.id,
                            color: req.body.color,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });

            // ── Doors ─────────────────────────────────────────────────────────
            dev.get('/doors', call('list_doors'));
            dev.post('/doors/:id/lock', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('lock_door', {
                            nukiId: +req.params.id,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.post('/doors/:id/unlock', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('unlock_door', {
                            nukiId: +req.params.id,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });

            // ── Spotify ───────────────────────────────────────────────────────
            dev.get('/spotify', call('get_playback_state'));
            dev.post('/spotify/play', call('play_music'));
            dev.post('/spotify/pause', call('pause_music'));
            dev.post('/spotify/next', call('next_track'));
            dev.post('/spotify/previous', call('previous_track'));
            dev.patch('/spotify/volume', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('set_volume', {
                            percent: +req.body.percent,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });

            // ── TV ────────────────────────────────────────────────────────────
            dev.get('/tv', call('tv_get_status'));
            dev.post('/tv/on', async (_req: any, res: any) => {
                try {
                    res.json(await deviceHandler('tv_power', { state: 'on' }));
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.post('/tv/off', async (_req: any, res: any) => {
                try {
                    res.json(await deviceHandler('tv_power', { state: 'off' }));
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.patch('/tv/volume', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('tv_set_volume', {
                            level: +req.body.level,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.post('/tv/mute', async (_req: any, res: any) => {
                try {
                    res.json(await deviceHandler('tv_mute', { mute: true }));
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.post('/tv/unmute', async (_req: any, res: any) => {
                try {
                    res.json(await deviceHandler('tv_mute', { mute: false }));
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });

            app.use('/devices', dev);
        }

        // ── Scenes ────────────────────────────────────────────────────────────
        if (scenesHandler) {
            const sc = express.Router();

            sc.use((req: any, res: any, next: any) => {
                const bearer = req.headers['authorization']?.split(' ')[1];
                if (!this.checkPassword(bearer, req.ip)) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }
                next();
            });

            // List all scenes
            sc.get('/', (_req: any, res: any) => {
                res.json(scenesHandler.list());
            });

            // Trigger a scene
            sc.post('/:id/trigger', async (req: any, res: any) => {
                try {
                    const result = await scenesHandler.trigger(req.params.id);
                    res.json(result);
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });

            // Create a custom scene
            sc.post('/', (req: any, res: any) => {
                try {
                    const scene = scenesHandler.create(req.body);
                    res.status(201).json(scene);
                } catch (e: any) {
                    res.status(400).json({ error: e.message });
                }
            });

            // Delete a custom scene
            sc.delete('/:id', (req: any, res: any) => {
                const ok = scenesHandler.remove(req.params.id);
                if (!ok)
                    return res
                        .status(404)
                        .json({ error: 'Scene not found or is built-in' });
                res.json({ success: true });
            });

            app.use('/scenes', sc);
        }

        return new Promise((resolve, reject) => {
            this.server = app
                .listen(port, () => {
                    Logger.info(`HTTP listener on port ${port}`);
                    resolve();
                })
                .on('error', reject);
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}
