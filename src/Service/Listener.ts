import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import CommandExecutor from './CommandExecutor';
import Logger from '../Logger';
import env from '../env';
import cors from 'cors';
import Orchestrator from './Orchestrator';

export default class Listener {
    constructor(
        private readonly commandExecutor: CommandExecutor,
        private readonly orchestrator: Orchestrator,
    ) {
        Logger.info('Listener created');
    }

    async init(): Promise<void> {
        try {
            // await this.listenOnWeb();
            await this.listenOnStdin();
        } catch (error) {
            Logger.error(
                `Error during the initialisation of Listener: ${error}`,
            );
            throw new Error('Error during the initialisation of Listener');
        }
    }

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

            app.get('/', (req: any, res: any) => {
                if (req.query.code) {
                    this.commandExecutor.spotifyAuth(req.query.code);
                }
                res.status(200).send('Hello World');
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
        process.stdin.on('data', async (text: string) => {
            Logger.info(
                `STDIN Listener: Received order ${text.replace('\n', '')}`,
            );
            try {
                const order = {
                    content: text.replace('\n', ''),
                    timestamp: Date.now().toString(),
                };
                this.orchestrator.getRouterQueriesFromOrder(order);
            } catch (error) {
                Logger.error(
                    `STDIN Listener: Error during the execution of the command: ${error}`,
                );
            }
            process.stdout.write('Order received\n');
            process.stdin.pause();
        });
    }
}
