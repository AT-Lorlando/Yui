import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import * as wifi from 'node-wifi';
import CommandExecutor from './CommandExecutor';
import SpotifyController from './SpotifyController';
import { logger } from './logger';
import env from './env';

export default class Listener {
    private commandExecutor: CommandExecutor | undefined;
    private spotifyController: SpotifyController | undefined;

    async init(
        commandExecutor: CommandExecutor,
        spotifyController: SpotifyController,
    ): Promise<void> {
        this.commandExecutor = commandExecutor;
        this.spotifyController = spotifyController;

        await this.listenOnWeb();
        await this.listenOnStdin();
    }

    private async listenOnWeb(): Promise<void> {
        return new Promise((resolve, reject) => {
            const port = 3000;
            const app = express();
            app.use(bodyParser.json());
            app.use(bodyParser.urlencoded({ extended: true }));
            if (!fs.existsSync('banned_ips.txt')) {
                fs.writeFileSync('banned_ips.txt', '');
            }

            app.post('/command', (req: any, res: any) => {
                if (this.commandExecutor === undefined) {
                    throw new Error('CommandExecutor is undefined');
                }
                const ip =
                    req.headers['x-forwarded-for'] ||
                    req.connection.remoteAddress;
                try {
                    if (
                        fs.readFileSync('banned_ips.txt', 'utf8').includes(ip)
                    ) {
                        logger.error(`Post from banned IP: ${ip}`);
                        res.status(401).send('Banned IP');
                        return;
                    }
                } catch (error) {
                    throw error;
                }
                const bearer = req.headers.authorization;

                if (bearer === undefined || bearer !== env.BEARER_TOKEN) {
                    logger.error('Wrong password');
                    logger.error(`Banned IP: ${ip}`);
                    logger.error(req.body);
                    fs.appendFileSync('banned_ips.txt', `${ip}\n`);
                    res.status(401).send('Wrong password');
                    this.commandExecutor.PushNotification(
                        'Yui - Alert',
                        'Unauthorized request, IP banned' + ip,
                    );
                    return;
                }
                const command = req.body.command;
                logger.info(`Received command ${command.replace('\n', '')}`);
                try {
                    switch (command) {
                        case 'backhome':
                            logger.info('Going back home');
                            res.status(200).send('Going back home');
                            this.commandExecutor.backHome();
                            this.waitForPhone();
                            break;
                        case 'leavehome':
                            logger.info('Leaving home');
                            res.status(200).send('Leaving home');
                            this.commandExecutor.leaveHome();
                            break;
                        default:
                            this.commandExecutor.evalCommandFromOrder(command);
                            res.status(200).send('Command received');
                            return;
                    }
                } catch (error: any) {
                    logger.error(error.message);
                    res.status(500).send(error.message);
                    return;
                }
            });

            app.get('/', (req: any, res: any) => {
                res.status(200).send('Yui is up and running');
                console.log(req.query.code);

                if (req.query.code) {
                    if (this.spotifyController === undefined) {
                        throw new Error('SpotifyController is undefined');
                    }
                    this.spotifyController
                        .exchangeAuthorizationCode(req.query.code)
                        .then(({ accessToken, refreshToken }) => {
                            if (this.spotifyController === undefined) {
                                throw new Error(
                                    'SpotifyController is undefined',
                                );
                            }
                            this.spotifyController.saveRefreshToken(
                                refreshToken,
                            );
                            this.spotifyController.setAccessToken(accessToken);
                        });
                }
            });

            app.listen(port, () => {
                logger.info(`Listening on port ${port}`);
                resolve();
            }).on('error', (error) => {
                reject(error);
            });
        });
    }

    private async listenOnStdin(): Promise<void> {
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (text: string) => {
            if (this.commandExecutor === undefined) {
                throw new Error('CommandExecutor is undefined');
            }
            logger.info(`Received command ${text.replace('\n', '')}`);
            try {
                this.commandExecutor.evalCommandFromOrder(text);
            } catch (error) {
                logger.error(
                    `Error during the execution of the command: ${error}`,
                );
            }
        });
    }

    async detectPhone(phoneMacAddress: string, timeout = 30): Promise<void> {
        return new Promise(async (resolve, reject) => {
            wifi.init({
                iface: null, // iface à utiliser si vous avez plusieurs interfaces réseau
            });

            const checkPhoneConnected = async (): Promise<boolean> => {
                const devices = await wifi.getCurrentConnections();
                console.log(devices);
                return devices.some((device) => device.mac === phoneMacAddress);
            };

            const detectWithTimeout = async (): Promise<void> => {
                const isPhoneConnected = await checkPhoneConnected();

                if (isPhoneConnected) {
                    resolve();
                } else {
                    const timer = setTimeout(async () => {
                        if (!isPhoneConnected) {
                            reject(
                                new Error(
                                    'Phone not detected within the timeout',
                                ),
                            );
                        }
                    }, timeout * 1000);

                    while (!isPhoneConnected && timer.refresh) {
                        await new Promise((r) => setTimeout(r, 1000)); // Attendez 1 seconde
                    }

                    clearTimeout(timer);
                }
            };

            detectWithTimeout();
        });
    }

    private async waitForPhone() {
        this.detectPhone(env.PHONE_MAC_ADDRESS)
            .then(async () => {
                logger.info('Phone back to home');
                if (this.spotifyController === undefined) {
                    throw new Error('SpotifyController is undefined');
                }
                if (this.commandExecutor === undefined) {
                    throw new Error('CommandExecutor is undefined');
                }
                if (await this.spotifyController.isPlaying()) {
                    logger.info('Spotify is playing');
                    // transfer playback to speaker
                    const speaker =
                        (await this.spotifyController.getSpeakerByName(
                            'Les enceintes',
                        )) as any;
                    if (speaker === undefined) {
                        throw new Error('Speaker not found');
                    }
                    await this.spotifyController.transferPlayback(speaker.id);
                }
            })
            .catch(() => {
                // Phone not detected
            });
    }
}
