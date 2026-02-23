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
} from './InputSource';

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
        handler: (order: string) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
        deviceHandler?: DeviceHandler,
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

        // ── Blocking endpoint (used by stdin, cron, etc.) ─────────────────────
        app.post('/order', async (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const order = req.body?.order;
            if (!order || typeof order !== 'string') {
                return res.status(400).json({ error: 'Missing "order" field' });
            }

            try {
                const result = await handler(order);
                return res.status(200).json({ response: result });
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

                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                try {
                    for await (const token of streamHandler(order)) {
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
