import SpotifyWebApi from 'spotify-web-api-node';
import axios from 'axios';
import http from 'http';
import { URL } from 'url';
import Logger from './logger';

const SCOPES = [
    'user-modify-playback-state',
    'user-read-playback-state',
    'user-read-currently-playing',
    'streaming',
];

export class SpotifyAuth {
    static async connect(): Promise<SpotifyWebApi> {
        const clientId = process.env.SPOTIFY_CLIENT_ID;
        const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
        const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

        if (!clientId || !clientSecret || !refreshToken) {
            throw new Error(
                'Missing Spotify credentials. Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN in .env.\n' +
                    'Run "npm run setup:spotify" to configure.',
            );
        }

        const accessToken = await SpotifyAuth.refreshAccessToken(
            clientId,
            clientSecret,
            refreshToken,
        );

        const api = new SpotifyWebApi({ clientId, clientSecret });
        api.setAccessToken(accessToken);
        api.setRefreshToken(refreshToken);

        Logger.info('Spotify API authenticated');
        return api;
    }

    static async refreshAccessToken(
        clientId: string,
        clientSecret: string,
        refreshToken: string,
    ): Promise<string> {
        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });

        const response = await axios.post(
            'https://accounts.spotify.com/api/token',
            params.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization:
                        'Basic ' +
                        Buffer.from(`${clientId}:${clientSecret}`).toString(
                            'base64',
                        ),
                },
            },
        );

        return response.data.access_token;
    }

    static async startAuthFlow(
        clientId: string,
        clientSecret: string,
        redirectUri: string,
    ): Promise<{ accessToken: string; refreshToken: string }> {
        const api = new SpotifyWebApi({
            clientId,
            clientSecret,
            redirectUri,
        });

        const authorizeUrl = api.createAuthorizeURL(SCOPES, 'yui-setup');
        console.log('\nOpen this URL in your browser to authorize Yui:\n');
        console.log(`  ${authorizeUrl}\n`);

        const code = await SpotifyAuth.waitForCallback(redirectUri);

        const params = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
        });

        const response = await axios.post(
            'https://accounts.spotify.com/api/token',
            params.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization:
                        'Basic ' +
                        Buffer.from(`${clientId}:${clientSecret}`).toString(
                            'base64',
                        ),
                },
            },
        );

        return {
            accessToken: response.data.access_token,
            refreshToken: response.data.refresh_token,
        };
    }

    private static waitForCallback(redirectUri: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(redirectUri);
            const port = Number(parsed.port) || 8888;
            const callbackPath = parsed.pathname || '/callback';

            const server = http.createServer((req, res) => {
                const url = new URL(req.url ?? '', `http://localhost:${port}`);

                if (url.pathname !== callbackPath) {
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    res.end('<h1>Not found</h1>');
                    return;
                }

                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');

                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(
                        '<h1>Authorization denied</h1><p>You can close this tab.</p>',
                    );
                    server.close();
                    reject(new Error(`Authorization denied: ${error}`));
                    return;
                }

                if (code) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(
                        '<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>',
                    );
                    server.close();
                    resolve(code);
                    return;
                }

                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<h1>Missing code parameter</h1>');
            });

            server.listen(port, '0.0.0.0', () => {
                console.log(
                    `Waiting for callback on 0.0.0.0:${port}${callbackPath} (redirect URI: ${redirectUri})`,
                );
            });

            setTimeout(() => {
                server.close();
                reject(new Error('Authorization timed out after 2 minutes'));
            }, 120_000);
        });
    }
}
