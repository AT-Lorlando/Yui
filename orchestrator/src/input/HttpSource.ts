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
    AutomationsHandler,
    PresenceHandler,
    ConversationsHandler,
    IntegrationsHandler,
    ProactiveHandler,
    DashboardHandler,
} from './InputSource';
import { makeRequireAuth } from './routes/helpers';
import { deviceRoutes } from './routes/devices';
import { sceneRoutes } from './routes/scenes';
import { effectRoutes } from './routes/effects';
import { automationRoutes } from './routes/automations';
import { conversationRoutes } from './routes/conversations';
import { presenceRoutes } from './routes/presence';
import { memoryRoutes } from './routes/memory';
import { promptRoutes } from './routes/prompts';
import { configRoutes } from './routes/config';
import { miscRoutes } from './routes/misc';

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

/**
 * API HTTP de l'orchestrateur (port 4000).
 *
 * Ce fichier ne porte plus que : le socle express, les routes statiques
 * publiques, /status, /tools et les deux endpoints d'ordre (/order,
 * /order/stream). Tout le reste vit dans `routes/<domaine>.ts` — un router
 * par domaine, l'auth Bearer via le middleware unique `makeRequireAuth`.
 *
 * ⚠️ Règle apprise à la dure : un router monté sur '/' ne doit JAMAIS porter
 * d'auth en `router.use` — le middleware intercepte TOUTES les requêtes et
 * 401-ait les endpoints publics déclarés après lui (c'est ce qui a cassé
 * /chime, donc les sonneries de minuteur, de juin à septembre 2026).
 */
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
            conversationId?: string,
        ) => Promise<string>,
        streamHandler?: StreamHandler,
        statusHandler?: StatusHandler,
        deviceHandler?: DeviceHandler,
        scenesHandler?: ScenesHandler,
        toolsHandler?: ToolsHandler,
        automationsHandler?: AutomationsHandler,
        presenceHandler?: PresenceHandler,
        conversationsHandler?: ConversationsHandler,
        integrationsHandler?: IntegrationsHandler,
        proactiveHandler?: ProactiveHandler,
        dashboardHandler?: DashboardHandler,
    ): Promise<void> {
        const port = Number(
            process.env.ORCHESTRATOR_PORT ?? process.env.PORT ?? 4000,
        );
        const app = express();
        app.use(cors({ origin: '*' }));
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));

        const requireAuth = makeRequireAuth((bearer, ip) =>
            this.checkPassword(bearer, ip),
        );

        app.get('/health', (_req: any, res: any) => {
            res.status(200).json({ status: 'ok' });
        });

        // ── Dashboard kiosque (lecture seule, sans auth — LAN) ──────────────────
        app.get('/dashboard', async (_req: any, res: any) => {
            if (!dashboardHandler) {
                return res.status(503).json({ error: 'dashboard unavailable' });
            }
            try {
                res.json(await dashboardHandler());
            } catch (err: any) {
                Logger.error(`/dashboard failed: ${err?.message ?? err}`);
                res.status(500).json({ error: 'dashboard failed' });
            }
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

        // ── APK download ───────────────────────────────────────────────────────
        // GET /download/apk — serves the latest built Android debug APK,
        // placed at assets/apk/yui.apk by `npm run build:apk`. Public (no auth,
        // like ringtones/chimes/media) — sideload convenience from the web app.
        const apkPath = path.join(process.cwd(), 'assets', 'apk', 'yui.apk');
        app.get('/download/apk', (_req: any, res: any) => {
            if (!fs.existsSync(apkPath)) {
                return res.status(404).json({
                    error: 'APK not built yet (run npm run build:apk)',
                });
            }
            res.download(apkPath, 'yui.apk');
        });

        // ── Dossier de téléchargements partagé ────────────────────────────────
        // Tout fichier déposé dans YUI_DOWNLOAD_DIR (défaut /share/yui_download)
        // devient téléchargeable — APK fraîchement buildé, exports, etc. Les
        // symlinks sont suivis (le dossier peut lui-même en être un). Public
        // comme /download/apk : pratique de sideload depuis n'importe quel
        // appareil du LAN.
        const downloadDir =
            process.env.YUI_DOWNLOAD_DIR ?? '/share/yui_download';
        app.get('/downloads', (_req: any, res: any) => {
            try {
                const entries = fs
                    .readdirSync(downloadDir)
                    .map((name) => {
                        try {
                            // statSync suit les symlinks : un lien vers un
                            // fichier est listé comme le fichier lui-même.
                            const st = fs.statSync(
                                path.join(downloadDir, name),
                            );
                            if (!st.isFile()) return null;
                            return { name, size: st.size, mtime: st.mtimeMs };
                        } catch {
                            return null; // lien cassé → ignoré
                        }
                    })
                    .filter(Boolean)
                    .sort((a: any, b: any) => b.mtime - a.mtime);
                res.json(entries);
            } catch {
                // Dossier absent (non créé sur cette machine) → liste vide.
                res.json([]);
            }
        });
        app.get('/downloads/:file', (req: any, res: any) => {
            // basename : impossible de sortir du dossier par ../.
            const name = path.basename(String(req.params.file));
            const full = path.join(downloadDir, name);
            try {
                if (!fs.statSync(full).isFile()) throw new Error('not a file');
            } catch {
                return res.status(404).json({ error: `"${name}" introuvable` });
            }
            res.download(full, name);
        });

        // ── Static voice-debug wakes ───────────────────────────────────────────
        // Served at /voice-debug/wakes/<file>.wav — recorded wake-word WAVs for
        // replay in the voice debug panel (written by the voice server).
        app.use(
            '/voice-debug/wakes',
            express.static(
                path.join(process.cwd(), 'data', 'voice-debug', 'wakes'),
            ),
        );

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
            app.post(
                '/tools/:name',
                requireAuth,
                async (req: any, res: any) => {
                    try {
                        const result = await toolsHandler.call(
                            req.params.name,
                            req.body || {},
                        );
                        return res.json({ result });
                    } catch (e: any) {
                        return res.status(500).json({ error: e.message });
                    }
                },
            );
        }

        // ── Blocking endpoint (used by mobile app, cron, etc.) ───────────────
        // If the request body contains `audio: true`, the response includes
        // TTS audio as base64 WAV so the caller can play it locally.
        // The voice pipeline sends `voice: true` (not `audio: true`) and handles
        // its own TTS — it never receives audio bytes here.
        app.post('/order', requireAuth, async (req: any, res: any) => {
            const order = req.body?.order;
            if (!order || typeof order !== 'string') {
                return res.status(400).json({ error: 'Missing "order" field' });
            }

            const wantsAudio = req.body?.audio === true;
            const reset = req.body?.reset === true;
            const outputChannel = req.body?.voice === true ? 'cast' : 'none';
            const conversationId =
                typeof req.body?.conversationId === 'string'
                    ? req.body.conversationId
                    : undefined;

            try {
                const result = await handler(
                    order,
                    reset,
                    outputChannel,
                    conversationId,
                );
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
            app.post(
                '/order/stream',
                requireAuth,
                async (req: any, res: any) => {
                    const order = req.body?.order;
                    if (!order || typeof order !== 'string') {
                        return res
                            .status(400)
                            .json({ error: 'Missing "order" field' });
                    }

                    // Voice pipeline sends "voice: true" → cap response length
                    const isVoice = req.body?.voice === true;
                    const reset = req.body?.reset === true;
                    const conversationId =
                        typeof req.body?.conversationId === 'string'
                            ? req.body.conversationId
                            : undefined;

                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.flushHeaders();

                    const streamOutputChannel = isVoice ? 'cast' : 'none';
                    try {
                        let idSent = false;
                        for await (const token of streamHandler(
                            order,
                            {
                                outputChannel: streamOutputChannel,
                                conversationId,
                                appConversation: !isVoice,
                                onConversationId: (id: string) => {
                                    if (!idSent) {
                                        res.write(
                                            `data: ${JSON.stringify({
                                                conversationId: id,
                                            })}\n\n`,
                                        );
                                        idSent = true;
                                    }
                                },
                            },
                            reset,
                        )) {
                            if (typeof token === 'object' && token !== null) {
                                // Événement outil — le chat de l'app le rend en chip.
                                res.write(`data: ${JSON.stringify(token)}\n\n`);
                                continue;
                            }
                            res.write(`data: ${JSON.stringify({ token })}\n\n`);
                        }
                    } catch (error) {
                        Logger.error(`SSE stream error: ${error}`);
                        res.write(
                            `data: ${JSON.stringify({
                                error: String(error),
                            })}\n\n`,
                        );
                    } finally {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                },
            );
        }

        // ── Routers par domaine (routes/<domaine>.ts) ─────────────────────────
        if (deviceHandler) {
            app.use('/devices', deviceRoutes(requireAuth, deviceHandler));
            app.use(
                '/',
                effectRoutes(requireAuth, deviceHandler, toolsHandler),
            );
        }
        if (scenesHandler) {
            app.use('/scenes', sceneRoutes(requireAuth, scenesHandler));
        }
        if (automationsHandler) {
            app.use(
                '/automations',
                automationRoutes(requireAuth, automationsHandler),
            );
        }
        if (conversationsHandler) {
            app.use(
                '/conversations',
                conversationRoutes(requireAuth, conversationsHandler),
            );
        }
        app.use('/memory', memoryRoutes(requireAuth));
        app.use('/presence', presenceRoutes(requireAuth, presenceHandler));
        app.use('/prompts', promptRoutes(requireAuth));
        app.use(
            '/',
            configRoutes(requireAuth, integrationsHandler, proactiveHandler),
        );
        app.use('/', miscRoutes(requireAuth, deviceHandler));

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
