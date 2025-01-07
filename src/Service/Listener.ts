import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import CommandExecutor from './CommandExecutor';
import Logger from '../Logger';
import env from '../env';
import cors from 'cors';

// const BBOX_PASSWORD = env.BBOX_PASSWORD;
// const PHONE_MAC_ADDRESS = env.PHONE_MAC_ADDRESS;
// const PHONE_CHECK_INTERVAL = 10;
// const HOME_POSITION = {
//     latitude: parseFloat(env.HOME_LATITUDE),
//     longitude: parseFloat(env.HOME_LONGITUDE),
// };

export default class Listener {
    private commandExecutor!: CommandExecutor;

    async init(commandExecutor: CommandExecutor): Promise<void> {
        try {
            this.commandExecutor = commandExecutor;
            await this.listenOnWeb();
            await this.listenOnStdin();
        } catch (error) {
            Logger.error(
                `Error during the initialisation of Listener: ${error}`,
            );
            throw new Error('Error during the initialisation of Listener');
        }
    }

    // private isBannedIP(ip: string): boolean {
    //     try {
    //         const bannedIPs = fs.readFileSync('banned_ips.txt', 'utf8');
    //         return bannedIPs.includes(ip);
    //     } catch (error) {
    //         throw error;
    //     }
    // }

    private checkPassword(bearer: string | undefined, ip: string): boolean {
        // Todo: Add a rate limiter
        if (bearer === undefined || bearer !== env.BEARER_TOKEN) {
            Logger.error('Wrong password');
            Logger.error(`Banned IP: ${ip}`);
            fs.appendFileSync('banned_ips.txt', `${ip}\n`);
            return false;
        }
        return true;
    }

    private async listenOnWeb(): Promise<void> {
        return new Promise((resolve, reject) => {
            const port = 3000;
            const app = express();
            app.use(
                cors({
                    origin: '*', // Autoriser toutes les origines
                    // methods: ['GET', 'POST'], // Autoriser uniquement les méthodes GET et POST
                    // allowedHeaders: ['Content-Type', 'Authorization'] // Autoriser uniquement certains en-têtes
                }),
            );
            app.use(bodyParser.json());
            app.use(bodyParser.urlencoded({ extended: true }));
            if (!fs.existsSync('banned_ips.txt')) {
                fs.writeFileSync('banned_ips.txt', '');
            }

            app.post('/command', (req: any, res: any) => {
                if (this.commandExecutor === undefined) {
                    res.status(500).send('CommandExecutor is down');
                    throw new Error(
                        'CommandExecutor is undefined, cannot execute command',
                    );
                }
                const ip =
                    req.headers['x-forwarded-for'] ||
                    req.connection.remoteAddress;
                const bearer = req.headers.authorization;
                const command = req.body.command;
                Logger.info(
                    `WEB Listener: Received order ${command.replace('\n', '')}`,
                );

                // if (this.isBannedIP(ip)) {
                //     Logger.error(`Banned IP: ${ip}`);
                //     res.status(401).send('Unauthorized');
                //     return;
                // }
                if (!this.checkPassword(bearer, ip)) {
                    Logger.error(`Wrong password from IP: ${ip}`);
                    res.status(401).send('Unauthorized');
                    return;
                }

                try {
                    switch (command) {
                        case 'backhome':
                            Logger.info('Going back home');
                            res.status(200).send('Going back home');
                            this.commandExecutor.backHome();
                            break;
                        case 'leavehome':
                            Logger.info('Leaving home');
                            res.status(200).send('Leaving home');
                            this.commandExecutor.leaveHome();
                            break;
                        default:
                            this.commandExecutor.evalCommandFromOrder(command);
                            res.status(200).send('Order received');
                            return;
                    }
                } catch (error: any) {
                    Logger.error(error.message);
                    res.status(500).send(error.message);
                    return;
                }
            });

            app.get('/', (req: any, res: any) => {
                res.status(200).sendFile('assets/index.html', {
                    root: __dirname,
                });
                console.log(req.query.code);
                if (req.query.code) {
                    this.commandExecutor.spotifyAuth(req.query.code);
                }
            });

            app.post('/payload', (req: any, res: any) => {
                if (this.commandExecutor === undefined) {
                    res.status(500).send('CommandExecutor is down');
                    throw new Error(
                        'CommandExecutor is undefined, cannot execute command',
                    );
                }
                // const ip =
                //     req.headers['x-forwarded-for'] ||
                //     req.connection.remoteAddress;
                // const bearer = req.headers.authorization;
                const payload = req.body;
                Logger.info(
                    `WEB Listener: Received payload ${JSON.stringify(payload)}`,
                );

                // if (this.isBannedIP(ip)) {
                //     Logger.error(`Banned IP: ${ip}`);
                //     res.status(401).send('Unauthorized');
                //     return;
                // }
                // if (!this.checkPassword(bearer, ip)) {
                //     Logger.error(`Wrong password from IP: ${ip}`);
                //     res.status(401).send('Unauthorized');
                //     return;
                // }

                try {
                    // Analyse the payload
                    // The payload should be a JSON object with the following structure:
                    // {
                    //     "id": "unique_entity_id",
                    //     "position": {
                    //         "latitude": 48.123456,
                    //         "longitude": 2.123456
                    //     },
                    //     "status": "status"
                    // }
                    Logger.info(`Payload received: ${JSON.stringify(payload)}`);
                    res.status(200).send('Payload received');
                    return;
                } catch (error: any) {
                    Logger.error(error.message);
                    res.status(500).send(error.message);
                    return;
                }
            });

            app.listen(port, () => {
                Logger.info(`Listening on port ${port}`);
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
            Logger.info(
                `STDIN Listener: Received order ${text.replace('\n', '')}`,
            );
            try {
                this.commandExecutor.evalCommandFromOrder(text);
            } catch (error) {
                Logger.error(
                    `STDIN Listener: Error during the execution of the command: ${error}`,
                );
            }
        });
    }
}
