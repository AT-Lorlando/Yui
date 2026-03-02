import { execFile } from 'child_process';
import * as path from 'path';
import Logger from './logger';

const CAST_SCRIPT = path.join(__dirname, '..', 'cast.py');
const HOST = process.env.CHROMECAST_HOST ?? '10.0.0.140';
const PORT = String(process.env.CHROMECAST_PORT ?? '8009');

function run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'python3',
            [CAST_SCRIPT, HOST, PORT, ...args],
            { timeout: 40_000 },
            (error, stdout, stderr) => {
                if (error) {
                    Logger.error(`cast.py stderr: ${stderr}`);
                    reject(new Error(stderr?.trim() || error.message));
                } else {
                    Logger.debug(`cast.py: ${stdout.trim()}`);
                    resolve(stdout.trim());
                }
            },
        );
    });
}

export class ChromecastController {
    castYoutube(source: string): Promise<string> {
        Logger.info(`Chromecast: youtube "${source}"`);
        return run(['youtube', source]);
    }

    castNetflix(title?: string): Promise<string> {
        Logger.info(`Chromecast: netflix${title ? ` "${title}"` : ''}`);
        return title ? run(['netflix', title]) : run(['netflix']);
    }

    castCrunchyroll(title?: string): Promise<string> {
        Logger.info(`Chromecast: crunchyroll${title ? ` "${title}"` : ''}`);
        return title ? run(['crunchyroll', title]) : run(['crunchyroll']);
    }

    castDisney(title?: string): Promise<string> {
        Logger.info(`Chromecast: disney${title ? ` "${title}"` : ''}`);
        return title ? run(['disney', title]) : run(['disney']);
    }

    castPrime(title?: string): Promise<string> {
        Logger.info(`Chromecast: prime${title ? ` "${title}"` : ''}`);
        return title ? run(['prime', title]) : run(['prime']);
    }

    castMedia(url: string): Promise<string> {
        Logger.info(`Chromecast: media ${url}`);
        return run(['media', url]);
    }

    castStop(): Promise<string> {
        Logger.info('Chromecast: stop');
        return run(['stop']);
    }
}
