import SpotifyWebApi from 'spotify-web-api-node';
import env from './env';
import { Client, DefaultMediaReceiver } from 'castv2-client';
import { logger } from './logger';
import Bonjour from 'bonjour';

export default class SpotifyController {
    private spotifyApi: SpotifyWebApi;

    constructor() {
        this.spotifyApi = new SpotifyWebApi({
            clientId: env.SPOTIFY_CLIENT_ID,
            clientSecret: env.SPOTIFY_CLIENT_SECRET,
            redirectUri: env.SPOTIFY_REDIRECT_URI,
        });
    }

    public async init(): Promise<void> {}

    async setAccessToken(accessToken: string): Promise<void> {
        this.spotifyApi.setAccessToken(accessToken);
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

    async getDevices(): Promise<{}[]> {
        return new Promise<{}[]>((resolve) => {
            const bonjour = Bonjour();
            const devices: {}[] = [];

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

    async playOnGoogleHome(
        deviceIp: string,
        spotifyUrl: string,
    ): Promise<void> {
        return new Promise(async (resolve, reject) => {
            const client = new Client();
            client.connect(deviceIp, () => {
                client.launch(
                    DefaultMediaReceiver,
                    (error: any, player: any) => {
                        if (error) {
                            reject(error);
                        }

                        const metadata = {
                            type: 'audio/mpeg',
                            metadataType: 0,
                            title: 'Spotify',
                        };

                        player.load(
                            {
                                contentId: spotifyUrl,
                                contentType: 'audio/mpeg',
                                streamType: 'BUFFERED',
                                metadata,
                            },
                            { autoplay: true },
                            (error: Error) => {
                                if (error) {
                                    reject(error);
                                } else {
                                    resolve();
                                }
                            },
                        );
                    },
                );
            });

            client.on('error', (error: Error) => {
                reject(error);
            });
        });
    }

    generateAuthorizeUrl(
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
}
