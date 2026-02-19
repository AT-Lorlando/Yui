import { google } from 'googleapis';
import type { Auth } from 'googleapis';
import * as http from 'http';
import * as url from 'url';
import * as fs from 'fs';
import { resolve } from 'path';
import Logger from './logger';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_PORT = 6146;

// Path to root .env — works both from src/ (ts-node) and dist/ (compiled)
const ROOT_ENV_PATH = resolve(__dirname, '../../../.env');

export class GoogleAuth {
    static createOAuth2Client(
        clientId: string,
        clientSecret: string,
        redirectUri?: string,
    ): Auth.OAuth2Client {
        return new google.auth.OAuth2(
            clientId,
            clientSecret,
            redirectUri ?? `http://localhost:${REDIRECT_PORT}/callback`,
        );
    }

    /** Returns an authenticated OAuth2 client using the refresh token from env. */
    static async connect(): Promise<Auth.OAuth2Client> {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

        if (!clientId || !clientSecret || !refreshToken) {
            throw new Error(
                'Missing Google credentials. Run "npm run setup:calendar" first.',
            );
        }

        const oauth2Client = GoogleAuth.createOAuth2Client(clientId, clientSecret);
        oauth2Client.setCredentials({ refresh_token: refreshToken });

        // Proactively refresh to validate credentials on startup
        await oauth2Client.getAccessToken();

        return oauth2Client;
    }

    /** Runs the OAuth2 browser flow and returns the refresh token. Used by setup.ts. */
    static async startAuthFlow(
        clientId: string,
        clientSecret: string,
    ): Promise<{ refreshToken: string }> {
        const redirectUri = `http://localhost:${REDIRECT_PORT}/callback`;
        const oauth2Client = GoogleAuth.createOAuth2Client(clientId, clientSecret, redirectUri);

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent', // force consent so Google always returns a refresh token
        });

        console.log('\nOpen this URL in your browser to authorize Google Calendar access:\n');
        console.log(authUrl);
        console.log('\nWaiting for authorization callback...\n');

        const code = await GoogleAuth.waitForCallback(REDIRECT_PORT);
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
            throw new Error(
                'No refresh token returned. ' +
                'Revoke access at https://myaccount.google.com/permissions then re-run setup.',
            );
        }

        return { refreshToken: tokens.refresh_token };
    }

    private static waitForCallback(port: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                const parsed = url.parse(req.url ?? '', true);
                const code = parsed.query.code as string | undefined;
                const error = parsed.query.error as string | undefined;

                if (error) {
                    res.writeHead(400);
                    res.end('<h1>Authorization denied. You can close this tab.</h1>');
                    server.close();
                    reject(new Error(`OAuth error: ${error}`));
                    return;
                }

                if (code) {
                    res.writeHead(200);
                    res.end(
                        '<h1>Authorization successful!</h1>' +
                        '<p>You can close this tab and return to the terminal.</p>',
                    );
                    server.close();
                    resolve(code);
                }
            });

            server.listen(port, () => {
                Logger.info(`OAuth callback server listening on http://localhost:${port}/callback`);
            });

            server.on('error', reject);
        });
    }

    /** Idempotent .env updater — replaces existing key or appends. */
    static updateEnvFile(key: string, value: string): void {
        let content = fs.existsSync(ROOT_ENV_PATH)
            ? fs.readFileSync(ROOT_ENV_PATH, 'utf-8')
            : '';
        const regex = new RegExp(`^${key}=.*$`, 'm');
        const line = `${key}=${value}`;

        if (regex.test(content)) {
            content = content.replace(regex, line);
        } else {
            content = content.trimEnd() + '\n' + line + '\n';
        }

        fs.writeFileSync(ROOT_ENV_PATH, content, 'utf-8');
        Logger.info(`Updated .env: ${key}=***`);
    }
}
