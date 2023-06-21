import SpotifyWebApi from 'spotify-web-api-node';
import env from './env';
import { logger } from './logger';
import Bonjour from 'bonjour';
import * as fs from 'fs';
import axios from 'axios';

export default class SpotifyController {
    private spotifyApi: SpotifyWebApi;
    private flag = false;

    constructor() {
        this.spotifyApi = new SpotifyWebApi({
            clientId: env.SPOTIFY_CLIENT_ID,
            clientSecret: env.SPOTIFY_CLIENT_SECRET,
            redirectUri: env.SPOTIFY_REDIRECT_URI,
        });
    }

    public async init(): Promise<void> {
        const refreshToken = await this.loadRefreshToken();
        if (refreshToken !== null) {
            try {
                const access_token = await this.refreshAccessToken(
                    refreshToken,
                );
                this.spotifyApi.setAccessToken(access_token);
                logger.info('Yui is now authorized');
            } catch (error) {
                logger.error('Error refreshing access token:', error);
            }
        } else {
            const clientId = env.SPOTIFY_CLIENT_ID;
            const redirectUri = env.SPOTIFY_REDIRECT_URI;
            const scopes = [
                'app-remote-control',
                'user-modify-playback-state',
                'user-read-playback-state',
            ];
            const authorizeUrl = this.generateAuthorizeUrl(
                clientId,
                redirectUri,
                scopes,
            );
            logger.info(`Please go to ${authorizeUrl} and authorize Yui`);
            await this.isAuthorized();
            logger.info('Yui is now authorized');
        }
    }

    private generateAuthorizeUrl(
        clientId: string,
        redirectUri: string,
        scopes: string[],
    ): string {
        const baseUrl = 'https://accounts.spotify.com/authorize';
        const scopeParam = scopes.join(' ');
        const queryParams = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            scope: scopeParam,
        });
        return `${baseUrl}?${queryParams.toString()}`;
    }

    private async isAuthorized(): Promise<void> {
        return new Promise((resolve, reject) => {
            const checkFlag = () => {
                if (this.flag) {
                    clearInterval(intervalId);
                    resolve();
                }
            };
            const intervalId = setInterval(checkFlag, 5000);

            setTimeout(() => {
                clearInterval(intervalId);
                if (!this.flag) {
                    reject(
                        new Error('Flag did not turn true within 30 seconds'),
                    );
                }
            }, 30 * 1000);
        });
    }

    public async setAccessToken(accessToken: string): Promise<void> {
        this.spotifyApi.setAccessToken(accessToken);
        this.flag = true;
    }

    public async saveRefreshToken(refreshToken: string): Promise<void> {
        const data = { refreshToken };
        await fs.promises.writeFile('refresh-token.json', JSON.stringify(data));
    }

    public async loadRefreshToken(): Promise<string | null> {
        try {
            const data = await fs.promises.readFile(
                'refresh-token.json',
                'utf-8',
            );
            return JSON.parse(data).refreshToken;
        } catch (error) {
            console.error('Error loading refresh token:', error);
            return null;
        }
    }

    async exchangeAuthorizationCode(code: string): Promise<{
        accessToken: string;
        refreshToken: string;
    }> {
        const clientId = env.SPOTIFY_CLIENT_ID;
        const clientSecret = env.SPOTIFY_CLIENT_SECRET;
        const redirectUri = env.SPOTIFY_REDIRECT_URI;
        const tokenEndpoint = 'https://accounts.spotify.com/api/token';
        const authString = Buffer.from(`${clientId}:${clientSecret}`).toString(
            'base64',
        );
        const headers = {
            Authorization: `Basic ${authString}`,
        };
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
        });

        try {
            const response = await axios.post(tokenEndpoint, body.toString(), {
                headers: headers,
            });
            return {
                accessToken: response.data.access_token,
                refreshToken: response.data.refresh_token,
            };
        } catch (error) {
            console.error('Error exchanging authorization code:', error);
            throw new Error('Error exchanging authorization code');
        }
    }

    async refreshAccessToken(refreshToken: string): Promise<string> {
        const clientId = env.SPOTIFY_CLIENT_ID;
        const clientSecret = env.SPOTIFY_CLIENT_SECRET;
        const tokenEndpoint = 'https://accounts.spotify.com/api/token';
        const authString = Buffer.from(`${clientId}:${clientSecret}`).toString(
            'base64',
        );
        const headers = {
            Authorization: `Basic ${authString}`,
        };
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });

        try {
            const response = await axios.post(tokenEndpoint, body.toString(), {
                headers: headers,
            });
            return response.data.access_token;
        } catch (error) {
            console.error('Error refreshing access token:', error);
            throw new Error('Error refreshing access token');
        }
    }

    async play(): Promise<void> {
        try {
            await this.spotifyApi.play();
        } catch (error) {
            console.error('Error playing:', error);
        }
    }

    async pause(): Promise<void> {
        try {
            await this.spotifyApi.pause();
        } catch (error) {
            console.error('Error pausing:', error);
        }
    }

    async nextTrack(): Promise<void> {
        try {
            await this.spotifyApi.skipToNext();
        } catch (error) {
            console.error('Error skipping to next track:', error);
        }
    }

    async getDevices(): Promise<object[]> {
        return new Promise<object[]>((resolve) => {
            const bonjour = Bonjour();
            const devices: object[] = [];

            bonjour.find({ type: 'googlecast' }, (device) => {
                if (device.type === 'googlecast') {
                    logger.info(`Found Google Home device: ${device.name}`);
                    devices.push({
                        name: device.txt.fn,
                        type: device.txt.md,
                        host: device.host,
                        port: device.port,
                    });
                }
            });

            setTimeout(() => {
                resolve(devices);
            }, 2000);
        });
    }

    async isPlaying(): Promise<boolean> {
        try {
            const response = await this.spotifyApi.getMyCurrentPlaybackState();
            return response.body.is_playing;
        } catch (error) {
            console.error('Error getting current playback state:', error);
            return false;
        }
    }

    async getActiveDevice(): Promise<object | undefined> {
        try {
            const response = await this.spotifyApi.getMyDevices();
            const devices = response.body.devices;
            const activeDevice = devices.find((device) => device.is_active);
            return activeDevice;
        } catch (error) {
            console.error('Error getting active device:', error);
            return undefined;
        }
    }

    async transferPlayback(deviceId: string): Promise<void> {
        logger.info(`Transferring playback to device: ${deviceId}`);
        try {
            await this.spotifyApi.transferMyPlayback([deviceId]);
        } catch (error) {
            console.error('Error transferring playback:', error);
        }
    }

    async getSpeakerByName(name: string): Promise<object | undefined> {
        const devices = await this.getDevices();
        console.log(devices);
        return devices.find((device: any) => device.name === name);
    }
}
