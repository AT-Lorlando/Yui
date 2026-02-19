import { ChildProcess, spawn } from 'child_process';
import Logger from './logger';

const SEEDER_NAME = process.env.SPOTIFY_SEEDER_NAME || 'Yui-Seeder';

let librespotProcess: ChildProcess | null = null;

/**
 * Start a librespot instance as a permanent Spotify Connect device.
 * Uses the "pipe" backend so no audio is actually played.
 * Requires an access token so the device registers with Spotify's API.
 */
export function startSeeder(accessToken: string): void {
    if (librespotProcess) {
        Logger.debug('Seeder already running');
        return;
    }

    const bin = process.env.LIBRESPOT_PATH || 'librespot';

    const args = [
        '--name', SEEDER_NAME,
        '--backend', 'pipe',
        '--bitrate', '96',
        '--disable-audio-cache',
        '--access-token', accessToken,
        '--disable-discovery',
    ];

    Logger.info(`Starting librespot seeder as "${SEEDER_NAME}"`);
    Logger.debug(`${bin} ${args.filter((_, i) => args[i - 1] !== '--access-token').join(' ')}`);

    librespotProcess = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    librespotProcess.stdout?.on('data', (data: Buffer) => {
        Logger.debug(`librespot: ${data.toString().trim()}`);
    });

    librespotProcess.stderr?.on('data', (data: Buffer) => {
        Logger.debug(`librespot: ${data.toString().trim()}`);
    });

    librespotProcess.on('error', (err) => {
        Logger.error(`librespot failed to start: ${err.message}`);
        librespotProcess = null;
    });

    librespotProcess.on('exit', (code) => {
        Logger.warn(`librespot exited with code ${code}`);
        librespotProcess = null;
    });
}

export function stopSeeder(): void {
    if (librespotProcess) {
        librespotProcess.kill();
        librespotProcess = null;
        Logger.info('librespot seeder stopped');
    }
}

export function getSeederName(): string {
    return SEEDER_NAME;
}

export function isSeederRunning(): boolean {
    return librespotProcess !== null && !librespotProcess.killed;
}
