import SpotifyWebApi from 'spotify-web-api-node';
import env from './env';
import { Client, DefaultMediaReceiver } from 'castv2-client';
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

    public async init(): Promise<void> {
        try {
            const data = await this.spotifyApi.clientCredentialsGrant();
            this.spotifyApi.setAccessToken(data.body['access_token']);
        } catch (error) {
            console.error('Error initializing SpotifyController:', error);
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

    async getDevices(): Promise<any> {
        // Créez une instance Bonjour
        const bonjour = Bonjour();
        const devices: Bonjour.RemoteService[] = [];

        // Recherchez les appareils Google Home sur le réseau
        bonjour.find({ type: 'googlecast' }, (device) => {
            if (device.type === 'googlecast') {
                devices.push(device);
            }
        });

        return devices;
        // Vous pouvez également utiliser un événement pour écouter les nouveaux appareils
        // bonjour.find().on('up', (device) => {
        //   if (device.type === 'googlecast') {
        //     console.log('Google Home Device Found:', device);
        //   }
        // });
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
}
