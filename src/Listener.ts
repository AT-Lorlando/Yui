import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import CommandExecutor from './CommandExecutor';
import { logger } from './logger';
import env from './env';
import axios from 'axios';
import https from 'https';

const BBOX_PASSWORD = env.BBOX_PASSWORD;
const PHONE_MAC_ADDRESS = env.PHONE_MAC_ADDRESS;
const PHONE_CHECK_INTERVAL = 10;

export default class Listener {
    private commandExecutor!: CommandExecutor;

    async init(commandExecutor: CommandExecutor): Promise<void> {
        try {
            this.commandExecutor = commandExecutor;
            await this.listenOnWeb();
            await this.listenOnStdin();
            await this.monitorUserPresence();
        } catch (error) {
            logger.error(
                `Error during the initialisation of Listener: ${error}`,
            );
            throw new Error('Error during the initialisation of Listener');
        }
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
                logger.info(
                    `WEB Listener: Received order ${command.replace('\n', '')}`,
                );
                try {
                    switch (command) {
                        case 'backhome':
                            logger.info('Going back home');
                            res.status(200).send('Going back home');
                            this.commandExecutor.backHome();
                            break;
                        case 'leavehome':
                            logger.info('Leaving home');
                            res.status(200).send('Leaving home');
                            this.commandExecutor.leaveHome();
                            break;
                        default:
                            this.commandExecutor.evalCommandFromOrder(command);
                            res.status(200).send('Order received');
                            return;
                    }
                } catch (error: any) {
                    logger.error(error.message);
                    res.status(500).send(error.message);
                    return;
                }
            });

            app.get('/', (req: any, res: any) => {
                // send assets/index.html
                res.status(200).sendFile('assets/index.html', {
                    root: __dirname,
                });
                console.log(req.query.code);
                if (req.query.code) {
                    this.commandExecutor.spotifyAuth(req.query.code);
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
                throw new Error('STDIN Listener: CommandExecutor is undefined');
            }
            logger.info(
                `STDIN Listener: Received order ${text.replace('\n', '')}`,
            );
            try {
                this.commandExecutor.evalCommandFromOrder(text);
            } catch (error) {
                logger.error(
                    `STDIN Listener: Error during the execution of the command: ${error}`,
                );
            }
        });
    }

    async isPhoneConnected() {
        const agent = new https.Agent({
            rejectUnauthorized: false,
        });
        const loginResponse = await axios
            .post(
                'https://mabbox.bytel.fr/api/v1/login',
                `password=${BBOX_PASSWORD}`,
                { httpsAgent: agent },
            )
            .catch((error) => {
                logger.error(`Failed to login to Bbox API: ${error}`);
                return error.response;
            });

        if (loginResponse.status !== 200) {
            throw new Error('Failed to login to Bbox API');
        }

        const devicesResponse = await axios.get(
            'https://mabbox.bytel.fr/api/v1/hosts',
            {
                headers: {
                    Cookie: loginResponse.headers['set-cookie'],
                },
            },
        );

        if (devicesResponse.status !== 200) {
            throw new Error('Failed to fetch connected devices from Bbox API');
        }

        // Check if the phone is connected
        // console.log(devicesResponse.data[0].hosts.list)
        const phone = devicesResponse.data[0].hosts.list.find(
            (device: any) => device.macaddress === PHONE_MAC_ADDRESS,
        );
        if (phone) {
            // we use the "active" field to determine if the phone is connected
            const isConnected = phone.active === 1;
            logger.silly(
                `Phone is ${isConnected ? 'connected' : 'disconnected'}`,
            );
            const now = Math.floor(new Date().getTime() / 1000); // current time in seconds since the epoch
            const lastSeenSeconds = parseInt(phone.lastseen, 10); // second since the epoch
            const lastSeen = new Date((now - lastSeenSeconds) * 1000); // convert to milliseconds
            logger.silly(`Last seen: ${lastSeen.toLocaleString()}`);
            return {
                isConnected: isConnected,
                lastSeen: lastSeen,
            };
        } else {
            throw new Error(
                `Phone with MAC address ${PHONE_MAC_ADDRESS} not found in device list`,
            );
        }
    }

    async monitorUserPresence() {
        let { isConnected: wasConnected } = await this.isPhoneConnected();
        setInterval(async () => {
            try {
                const { isConnected, lastSeen } = await this.isPhoneConnected();
                if (isConnected !== wasConnected) {
                    if (isConnected) {
                        logger.info(
                            `User returned at ${lastSeen.toLocaleString()}`,
                        );
                        this.commandExecutor.backHome();
                    } else {
                        logger.info(
                            `User left at ${lastSeen.toLocaleString()}`,
                        );
                        this.commandExecutor.leaveHome();
                    }
                    wasConnected = isConnected;
                }
            } catch (error) {
                logger.error(`Failed to check phone connection: ${error}`);
            }
        }, PHONE_CHECK_INTERVAL * 1000);
    }
}
