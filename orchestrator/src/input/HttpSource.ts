import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import * as path from 'path';
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
    LocationHandler,
    AutomationsHandler,
    PresenceHandler,
} from './InputSource';
import {
    loadStore,
    saveMemory,
    deleteMemory,
    setNamespacePriority,
    deleteNamespace,
} from '../orchestrator/memory';
import { saveFcmToken } from '../orchestrator/notify';
import { loadHistory } from '../orchestrator/history';
import { listPrompts, writePrompt } from '../orchestrator/prompts';
import {
    listPresets,
    addPreset,
    removePreset,
} from '../orchestrator/timerPresets';
import {
    loadIrrigationConfig,
    saveIrrigationConfig,
} from '../orchestrator/irrigationConfig';
import {
    getRemotesSnapshot,
    saveRemotesConfig,
} from '../orchestrator/hueRemotes';
import { animationManager } from '../orchestrator/animation/animationManager';

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
        handler: (
            order: string,
            reset?: boolean,
            outputChannel?: import('../orchestrator/automations').OutputChannel,
        ) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
        deviceHandler?: DeviceHandler,
        scenesHandler?: ScenesHandler,
        toolsHandler?: ToolsHandler,
        locationHandler?: LocationHandler,
        automationsHandler?: AutomationsHandler,
        presenceHandler?: PresenceHandler,
    ): Promise<void> {
        const port = Number(process.env.PORT ?? 3000);
        const app = express();
        app.use(cors({ origin: '*' }));
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));

        app.get('/health', (_req: any, res: any) => {
            res.status(200).json({ status: 'ok' });
        });

        // ── Static ringtones ───────────────────────────────────────────────────
        // Served at /ringtones/<filename> — used by mcp-timer for alarm sounds.
        const ringtonesDir = path.join(process.cwd(), 'assets', 'ringtones');
        app.use('/ringtones', express.static(ringtonesDir));

        // ── Static chimes ─────────────────────────────────────────────────────
        // Served at /chimes/<filename> — used for Yui's acknowledgment sounds.
        const chimesDir = path.join(process.cwd(), 'assets', 'chimes');
        app.use('/chimes', express.static(chimesDir));

        // ── Static media ───────────────────────────────────────────────────────
        // Served at /media/<wallpapers|videos>/<filename> — used by mcp-media.
        const mediaDir = path.join(process.cwd(), 'assets', 'media');
        app.use('/media', express.static(mediaDir));

        // ── Image → infinite MP4 loop ─────────────────────────────────────────
        // GET /media/loop/<subdir>/<file> streams an image as an infinite MP4.
        // Used by cast_wallpaper so the Chromecast keeps displaying it.
        app.get('/media/loop/:subdir/:file', (req: any, res: any) => {
            const { subdir } = req.params;
            // URL uses .mp4 extension — find the actual source image by stem
            const stem = path.basename(req.params.file, '.mp4');
            const dir = path.join(mediaDir, subdir);
            let filePath: string | undefined;
            try {
                const match = fs
                    .readdirSync(dir)
                    .find((f) => f.replace(/\.[^.]+$/, '') === stem);
                if (match) filePath = path.join(dir, match);
            } catch {
                /* ignore */
            }
            if (!filePath || !fs.existsSync(filePath))
                return res.status(404).end();
            const { spawn } = require('child_process');
            const ffmpeg = spawn(
                'ffmpeg',
                [
                    '-loop',
                    '1',
                    '-i',
                    filePath,
                    '-c:v',
                    'libx264',
                    '-preset',
                    'ultrafast',
                    '-tune',
                    'stillimage',
                    '-pix_fmt',
                    'yuv420p',
                    '-vf',
                    'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
                    '-movflags',
                    'frag_keyframe+empty_moov+default_base_moof',
                    '-f',
                    'mp4',
                    'pipe:1',
                ],
                { stdio: ['ignore', 'pipe', 'ignore'] },
            );
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Cache-Control', 'no-cache');
            ffmpeg.stdout.pipe(res);
            req.on('close', () => ffmpeg.kill());
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
            const outputChannel = req.body?.voice === true ? 'cast' : 'none';

            try {
                const result = await handler(order, reset, outputChannel);
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

                const streamOutputChannel = isVoice ? 'cast' : 'none';
                try {
                    for await (const token of streamHandler(
                        order,
                        { outputChannel: streamOutputChannel },
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

            // ── Covers (Somfy) ────────────────────────────────────────────────
            dev.get('/covers', call('list_covers'));
            dev.post('/covers/open', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('open_cover', {
                            device: req.body.device,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.post('/covers/close', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('close_cover', {
                            device: req.body.device,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.patch('/covers/position', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('set_cover_position', {
                            device: req.body.device,
                            position: +req.body.position,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });

            // ── Irrigation ────────────────────────────────────────────────────
            dev.get('/irrigation', call('irrigation_status'));
            dev.post('/irrigation/start', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('irrigation_start', {
                            target: req.body.target,
                            amount: req.body.amount,
                        }),
                    );
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });
            dev.post('/irrigation/stop', async (req: any, res: any) => {
                try {
                    res.json(
                        await deviceHandler('irrigation_stop', {
                            target: req.body?.target ?? 'all',
                        }),
                    );
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
                    const {
                        name,
                        icon,
                        color,
                        description,
                        setup,
                        state,
                        favorite,
                        intro,
                        floating,
                    } = req.body;
                    const scene = scenesHandler.create({
                        name,
                        icon,
                        color,
                        description,
                        setup,
                        state,
                        favorite,
                        intro,
                        floating,
                    });
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

            // Update a custom scene
            sc.patch('/:id', (req: any, res: any) => {
                try {
                    const {
                        name,
                        icon,
                        color,
                        description,
                        setup,
                        state,
                        favorite,
                        intro,
                        floating,
                    } = req.body;
                    const scene = scenesHandler.update(req.params.id, {
                        name,
                        icon,
                        color,
                        description,
                        setup,
                        state,
                        favorite,
                        intro,
                        floating,
                    });
                    if (!scene)
                        return res
                            .status(404)
                            .json({ error: 'Scene not found or is built-in' });
                    res.json(scene);
                } catch (e: any) {
                    res.status(400).json({ error: e.message });
                }
            });

            // Toggle favorite
            sc.patch('/:id/favorite', (req: any, res: any) => {
                const scene = scenesHandler.toggleFavorite(req.params.id);
                if (!scene)
                    return res.status(404).json({ error: 'Scene not found' });
                res.json({ scene });
            });

            app.use('/scenes', sc);
        }

        // ── Animation routes ──────────────────────────────────────────────────
        if (deviceHandler) {
            const anim = express.Router();
            anim.use((req: any, res: any, next: any) => {
                const bearer = req.headers['authorization']?.split(' ')[1];
                if (!this.checkPassword(bearer, req.ip)) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }
                next();
            });

            // Preview an intro once (no persistence).
            anim.post('/animations/preview', async (req: any, res: any) => {
                try {
                    await animationManager.playIntro(
                        req.body?.intro ?? [],
                        deviceHandler,
                    );
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(400).json({ error: e.message });
                }
            });

            // Start a floating preview.
            anim.post('/floating/start', async (req: any, res: any) => {
                try {
                    await animationManager.startFloating(
                        req.body?.floating,
                        deviceHandler,
                    );
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(400).json({ error: e.message });
                }
            });

            // Stop all floating animations.
            anim.post('/floating/stop', async (_req: any, res: any) => {
                await animationManager.stopAll();
                res.json({ success: true });
            });

            app.use('/', anim);
        }

        // ── Automations ───────────────────────────────────────────────────────
        if (automationsHandler) {
            const auto = express.Router();

            auto.use((req: any, res: any, next: any) => {
                const bearer = req.headers['authorization']?.split(' ')[1];
                if (!this.checkPassword(bearer, req.ip)) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }
                next();
            });

            auto.get('/', (_req: any, res: any) => {
                res.json(automationsHandler.list());
            });

            auto.get('/history', (_req: any, res: any) => {
                res.json(loadHistory());
            });

            auto.post('/', (req: any, res: any) => {
                try {
                    const automation = automationsHandler.add(req.body);
                    res.status(201).json(automation);
                } catch (e: any) {
                    res.status(400).json({ error: e.message });
                }
            });

            auto.patch('/:id', (req: any, res: any) => {
                try {
                    const { name, trigger, action, notify, enabled } = req.body;
                    const result = automationsHandler.update(req.params.id, {
                        name,
                        trigger,
                        action,
                        notify,
                        enabled,
                    });
                    if (!result)
                        return res
                            .status(404)
                            .json({ error: 'Automation not found' });
                    res.json(result);
                } catch (e: any) {
                    res.status(400).json({ error: e.message });
                }
            });

            auto.patch('/:id/toggle', (req: any, res: any) => {
                const msg = automationsHandler.toggle(req.params.id);
                if (msg === null)
                    return res
                        .status(404)
                        .json({ error: 'Automation not found' });
                res.json({ message: msg });
            });

            auto.delete('/:id', (req: any, res: any) => {
                const ok = automationsHandler.remove(req.params.id);
                if (!ok)
                    return res
                        .status(404)
                        .json({ error: 'Automation not found' });
                res.json({ success: true });
            });

            auto.post('/:id/run', async (req: any, res: any) => {
                try {
                    const result = await automationsHandler.run(req.params.id);
                    if (!result.success)
                        return res.status(404).json({ error: result.error });
                    res.json({ success: true });
                } catch (e: any) {
                    res.status(500).json({ error: e.message });
                }
            });

            app.use('/automations', auto);
        }

        // ── Memory (read-only) ────────────────────────────────────────────────
        app.get('/memory', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            res.json(loadStore());
        });

        app.post('/memory', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const { namespace, key, value, priority } = req.body ?? {};
            if (typeof namespace !== 'string' || !namespace.trim()) {
                return res.status(400).json({ error: 'namespace is required' });
            }
            if (priority && priority !== 'always' && priority !== 'on-demand') {
                return res
                    .status(400)
                    .json({ error: 'priority must be always or on-demand' });
            }
            if (key !== undefined) {
                if (typeof key !== 'string' || typeof value !== 'string') {
                    return res
                        .status(400)
                        .json({ error: 'key and value must be strings' });
                }
                if (key === '_priority') {
                    return res
                        .status(400)
                        .json({ error: '_priority is reserved' });
                }
                saveMemory(namespace, key, value, priority ?? 'always');
            } else if (priority) {
                setNamespacePriority(namespace, priority);
            } else {
                setNamespacePriority(namespace, 'always');
            }
            res.json(loadStore());
        });

        app.delete('/memory/:namespace/:key', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (req.params.key === '_priority') {
                return res.status(400).json({ error: '_priority is reserved' });
            }
            deleteMemory(req.params.namespace, req.params.key);
            res.json(loadStore());
        });

        app.delete('/memory/:namespace', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            deleteNamespace(req.params.namespace);
            res.json(loadStore());
        });

        // ── Timers (read from shared data file) ───────────────────────────────
        app.get('/timers', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            try {
                const timersFile = path.join(process.cwd(), 'data/timers.json');
                const raw = fs.existsSync(timersFile)
                    ? (JSON.parse(fs.readFileSync(timersFile, 'utf-8')) as {
                          id: string;
                          label: string;
                          duration_seconds: number;
                          started_at: number;
                          fires_at: number;
                          room?: string;
                      }[])
                    : [];
                const now = Date.now();
                res.json(
                    raw.map((t) => ({
                        ...t,
                        remaining_seconds: Math.max(
                            0,
                            Math.round((t.fires_at - now) / 1_000),
                        ),
                    })),
                );
            } catch {
                res.json([]);
            }
        });

        app.get('/timer-presets', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            res.json(listPresets());
        });

        app.post('/timer-presets', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            try {
                const preset = addPreset(req.body ?? {});
                res.status(201).json(preset);
            } catch (e: any) {
                res.status(400).json({ error: e.message });
            }
        });

        app.delete('/timer-presets/:id', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const ok = removePreset(req.params.id);
            if (!ok) return res.status(404).json({ error: 'Preset not found' });
            res.json({ success: true });
        });

        // ── Presence (current state) ──────────────────────────────────────────
        app.get('/presence', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            res.json({
                state: presenceHandler ? presenceHandler() : 'unknown',
            });
        });

        // ── Prompts (read markdown files from prompts/) ───────────────────────
        app.get('/prompts', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            res.json(listPrompts());
        });

        // :file may contain slashes (sub-folders) → wildcard param
        app.put('/prompts/*', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const file = req.params[0];
            const { content } = req.body ?? {};
            if (typeof content !== 'string') {
                return res
                    .status(400)
                    .json({ error: 'content must be a string' });
            }
            try {
                writePrompt(file, content);
                res.json({ success: true });
            } catch (e: any) {
                res.status(400).json({ error: e.message });
            }
        });

        // ── Chime cast (called internally by mcp-timer, no auth) ─────────────
        // Receives { url } and casts the audio file to the default speaker.
        app.post('/chime', async (req: any, res: any) => {
            const { url } = req.body ?? {};
            if (!url || !deviceHandler) return res.json({ ok: false });
            try {
                await deviceHandler('cast_media', {
                    content_id: url,
                    content_type: 'audio/mpeg',
                    title: 'Minuteur',
                });
                Logger.info(`Chime cast: ${url}`);
                return res.json({ ok: true });
            } catch (e: any) {
                Logger.error(`Chime cast failed: ${e.message}`);
                return res.status(500).json({ error: e.message });
            }
        });

        // ── Location & presence ───────────────────────────────────────────────
        // POST /location  — called by the mobile app with GPS coordinates.
        // Returns next_ping_ms so the app knows when to send the next update.
        app.get('/irrigation/config', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            res.json(loadIrrigationConfig());
        });

        app.put('/irrigation/config', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            try {
                const saved = saveIrrigationConfig(req.body);
                res.json(saved);
            } catch (err) {
                res.status(400).json({
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        });

        app.get('/remotes/hue', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            res.json(getRemotesSnapshot());
        });

        app.put('/remotes/hue', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            try {
                const saved = saveRemotesConfig(req.body);
                res.json({ ...getRemotesSnapshot(), config: saved });
            } catch (err) {
                res.status(400).json({
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        });

        app.post('/location', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const { lat, lng, accuracy } = req.body ?? {};
            if (typeof lat !== 'number' || typeof lng !== 'number') {
                return res
                    .status(400)
                    .json({ error: 'lat and lng are required numbers' });
            }

            if (!locationHandler) {
                // Presence system not configured — accept the ping, tell app to retry in 5 min
                Logger.info(
                    `Location received: ${lat.toFixed(5)},${lng.toFixed(
                        5,
                    )} (no presence handler)`,
                );
                return res.json({
                    state: 'unknown',
                    distance_m: -1,
                    next_ping_ms: 5 * 60_000,
                });
            }

            Logger.info(
                `[location] lat=${lat.toFixed(6)} lng=${lng.toFixed(
                    6,
                )} accuracy=±${Math.round(accuracy ?? 0)}m`,
            );
            const result = locationHandler(lat, lng, accuracy ?? 0);
            Logger.info(
                `[location] → state=${result.state} distance=${
                    result.distance_m
                }m next_ping=${Math.round(result.next_ping_ms / 1000)}s`,
            );
            return res.json(result);
        });

        // ── FCM device token registration ─────────────────────────────────────
        app.post('/devices/fcm-token', (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const { token } = req.body ?? {};
            if (!token || typeof token !== 'string') {
                return res.status(400).json({ error: 'Missing token' });
            }
            saveFcmToken(token);
            return res.json({ ok: true });
        });

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
