import { ChildProcess, spawn } from 'child_process';
import http from 'http';
import net from 'net';
import os from 'os';
import { PassThrough } from 'stream';
import Logger from './logger';

const SEEDER_NAME = process.env.SPOTIFY_SEEDER_NAME || 'Yui-Seeder';
const STREAM_PORT = parseInt(process.env.SPOTIFY_STREAM_PORT || '7777', 10);

let librespotProcess: ChildProcess | null = null;
let ffmpegProcess: ChildProcess | null = null;
let httpServer: http.Server | null = null;
let broadcast: PassThrough | null = null;
let activeClients = 0;

/** Local IP reachable by Cast devices on the same LAN */
function getLocalIp(): string {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] ?? []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

export function getStreamUrl(): string {
    return `http://${getLocalIp()}:${STREAM_PORT}/stream`;
}

export function getSeederName(): string {
    return SEEDER_NAME;
}

export function isStreamerRunning(): boolean {
    return librespotProcess !== null && !librespotProcess.killed;
}

/**
 * Start librespot with pipe backend → ffmpeg MP3 encoder → HTTP broadcast stream.
 * The resulting stream URL can be loaded by any Cast device via DefaultMediaReceiver.
 */
export function startStreamer(accessToken: string): void {
    if (librespotProcess) {
        Logger.debug('Streamer already running');
        return;
    }

    const bin = process.env.LIBRESPOT_PATH || 'librespot';

    // librespot: output raw S16LE PCM to stdout
    const librespotArgs = [
        '--name', SEEDER_NAME,
        '--backend', 'pipe',
        '--format', 'S16',
        '--bitrate', '160',
        '--disable-audio-cache',
        '--access-token', accessToken,
        '--disable-discovery',
        '--initial-volume', '100',
    ];

    Logger.info(`Starting librespot streamer as "${SEEDER_NAME}"`);
    librespotProcess = spawn(bin, librespotArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    librespotProcess.stderr?.on('data', (data: Buffer) => {
        Logger.debug(`librespot: ${data.toString().trim()}`);
    });

    librespotProcess.on('error', (err) => {
        Logger.error(`librespot failed: ${err.message}`);
        librespotProcess = null;
    });

    librespotProcess.on('exit', (code) => {
        if (code !== 0) Logger.warn(`librespot exited with code ${code}`);
        librespotProcess = null;
    });

    // ffmpeg: PCM S16LE 44100Hz stereo → MP3 stream
    const ffmpegArgs = [
        '-loglevel', 'error',
        '-f', 's16le', '-ar', '44100', '-ac', '2',
        '-i', 'pipe:0',
        '-codec:a', 'libmp3lame', '-q:a', '2',
        '-f', 'mp3', 'pipe:1',
    ];

    ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    // pipe librespot stdout → ffmpeg stdin
    librespotProcess.stdout?.pipe(ffmpegProcess.stdin!);

    ffmpegProcess.stderr?.on('data', (data: Buffer) => {
        Logger.debug(`ffmpeg: ${data.toString().trim()}`);
    });

    ffmpegProcess.on('error', (err) => {
        Logger.error(`ffmpeg failed: ${err.message}`);
        ffmpegProcess = null;
    });

    ffmpegProcess.on('exit', (code) => {
        if (code !== 0) Logger.warn(`ffmpeg exited with code ${code}`);
        ffmpegProcess = null;
    });

    // Broadcast stream: one PassThrough that all HTTP clients read from
    broadcast = new PassThrough();
    ffmpegProcess.stdout?.pipe(broadcast, { end: false });

    // HTTP server: stream MP3 to all Cast clients
    httpServer = http.createServer((req, res) => {
        if (req.url !== '/stream') {
            res.writeHead(404);
            res.end();
            return;
        }

        activeClients++;
        Logger.debug(`Cast client connected to stream (total: ${activeClients})`);

        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        // Pipe broadcast to this client
        const clientStream = new PassThrough();
        broadcast!.pipe(clientStream);

        clientStream.pipe(res, { end: false });

        req.on('close', () => {
            activeClients--;
            broadcast?.unpipe(clientStream);
            clientStream.destroy();
            Logger.debug(`Cast client disconnected (total: ${activeClients})`);
        });
    });

    httpServer.listen(STREAM_PORT, '0.0.0.0', () => {
        Logger.info(`Audio stream server listening on ${getStreamUrl()}`);
    });
}

export function stopStreamer(): void {
    httpServer?.close();
    httpServer = null;
    ffmpegProcess?.kill();
    ffmpegProcess = null;
    librespotProcess?.kill();
    librespotProcess = null;
    broadcast?.destroy();
    broadcast = null;
    Logger.info('Streamer stopped');
}

/** Wait until librespot registers as a Spotify Connect device */
export async function waitForSeederDevice(
    getDevices: () => Promise<Array<{ id?: string | null; name?: string | null }>>,
    maxWaitMs = 15000,
): Promise<string | undefined> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const devices = await getDevices();
        const seeder = devices.find(
            (d) => d.name?.toLowerCase() === SEEDER_NAME.toLowerCase(),
        );
        if (seeder?.id) return seeder.id;
        Logger.debug(`Seeder "${SEEDER_NAME}" not yet visible, waiting...`);
        await new Promise((r) => setTimeout(r, 2000));
    }
    return undefined;
}
