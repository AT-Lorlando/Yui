import Logger from './logger';

const SPOTIFY_APP_ID = 'CC32E753';
const SPOTIFY_NAMESPACE = 'urn:x-cast:com.spotify.chromecast.secure.v1';

/**
 * Wake up a Cast device by launching the Spotify receiver and sending credentials.
 * Returns a close function if successful.
 *
 * NOTE: This only works when the speaker is already registered in Spotify Connect.
 * For cold speakers, use castStream() instead.
 */
export function wakeUpSpeaker(
    host: string,
    accessToken: string,
    _speakerName: string,
    _isGroup = false,
): Promise<() => void> {
    const { Client, DefaultMediaReceiver } = require('castv2-client');

    return new Promise((resolve, reject) => {
        const client = new Client();
        const timeout = setTimeout(() => {
            client.close();
            reject(new Error(`Cast connect to ${host} timed out`));
        }, 30000);

        client.on('error', (err: Error) => {
            clearTimeout(timeout);
            client.close();
            reject(err);
        });

        client.connect(host, () => {
            Logger.debug(`Cast connected to ${host}`);

            class SpotifyReceiver extends DefaultMediaReceiver {
                static APP_ID = SPOTIFY_APP_ID;
            }

            client.launch(SpotifyReceiver, (err: Error | null, player: any) => {
                if (err) {
                    clearTimeout(timeout);
                    client.close();
                    Logger.warn(`Cast launch on ${host} failed: ${err.message}`);
                    reject(err);
                    return;
                }

                Logger.debug(`Cast launched Spotify receiver on ${host}`);

                const castClient = (client as any).client;
                const transportId = player.session.transportId;
                const senderId = `sender-${Math.floor(Math.random() * 10000)}`;

                const conn = castClient.createChannel(
                    senderId,
                    transportId,
                    'urn:x-cast:com.google.cast.tp.connection',
                    'JSON',
                );
                const spotifyChannel = castClient.createChannel(
                    senderId,
                    transportId,
                    SPOTIFY_NAMESPACE,
                    'JSON',
                );

                conn.send({ type: 'CONNECT' });

                Logger.debug(`Sending setCredentials to Spotify receiver on ${host}`);
                spotifyChannel.send({
                    type: 'setCredentials',
                    credentials: accessToken,
                    credentialsType: 'access_token',
                });

                const closeSession = () => {
                    client.close();
                    Logger.debug(`Cast session to ${host} closed`);
                };

                spotifyChannel.on('message', (data: any) => {
                    Logger.debug(`Spotify Cast message: ${JSON.stringify(data)}`);
                    if (data.type === 'credentialsSet' || data.type === 'credentialsSets') {
                        clearTimeout(timeout);
                        Logger.info(`Spotify Cast credentials set on ${host}`);
                        resolve(closeSession);
                    }
                    if (data.type === 'credentialsError') {
                        clearTimeout(timeout);
                        client.close();
                        reject(new Error(`credentialsError: ${JSON.stringify(data)}`));
                    }
                });

                // Fallback: resolve after 5s even without a response
                setTimeout(() => {
                    clearTimeout(timeout);
                    resolve(closeSession);
                }, 5000);
            });
        });
    });
}

/**
 * Stream an audio URL to a Cast device using DefaultMediaReceiver.
 * This works even when the speaker is not registered as a Spotify Connect device.
 * Returns a close function to stop the Cast session.
 */
export function castStream(
    host: string,
    streamUrl: string,
    contentType = 'audio/mpeg',
): Promise<() => void> {
    const { Client, DefaultMediaReceiver } = require('castv2-client');

    return new Promise((resolve, reject) => {
        const client = new Client();
        const timeout = setTimeout(() => {
            client.close();
            reject(new Error(`Cast stream connect to ${host} timed out`));
        }, 20000);

        client.on('error', (err: Error) => {
            clearTimeout(timeout);
            client.close();
            reject(err);
        });

        client.connect(host, () => {
            Logger.debug(`Cast connected to ${host} for stream`);

            client.launch(DefaultMediaReceiver, (err: Error | null, player: any) => {
                if (err) {
                    clearTimeout(timeout);
                    client.close();
                    reject(err);
                    return;
                }

                const media = {
                    contentId: streamUrl,
                    contentType,
                    streamType: 'LIVE',
                    metadata: {
                        type: 0,
                        metadataType: 0,
                        title: 'Yui',
                    },
                };

                player.load(media, { autoplay: true }, (loadErr: Error | null) => {
                    clearTimeout(timeout);
                    if (loadErr) {
                        client.close();
                        reject(loadErr);
                        return;
                    }

                    Logger.info(`Streaming audio to Cast device at ${host}`);
                    resolve(() => {
                        client.close();
                        Logger.debug(`Cast stream session to ${host} closed`);
                    });
                });
            });
        });
    });
}
