import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import cors from 'cors';
import * as http from 'http';
import Logger from '../logger';
import env from '../env';
import { InputSource } from './InputSource';

export class HttpSource implements InputSource {
    private server: http.Server | null = null;

    private checkPassword(bearer: string | undefined, ip: string): boolean {
        if (bearer === undefined || bearer !== env.BEARER_TOKEN) {
            Logger.error('Wrong password');
            Logger.error(`Banned IP: ${ip}`);
            fs.appendFileSync('banned_ips.txt', `${ip}\n`);
            return false;
        }
        return true;
    }

    async start(handler: (order: string) => Promise<string>): Promise<void> {
        const port = 3000;
        const app = express();
        app.use(cors({ origin: '*' }));
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));

        app.get('/health', (_req: any, res: any) => {
            res.status(200).json({ status: 'ok' });
        });

        app.post('/order', async (req: any, res: any) => {
            const bearer = req.headers['authorization']?.split(' ')[1];
            if (!this.checkPassword(bearer, req.ip)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const order = req.body?.order;
            if (!order || typeof order !== 'string') {
                return res.status(400).json({ error: 'Missing "order" field' });
            }

            try {
                const result = await handler(order);
                return res.status(200).json({ response: result });
            } catch (error) {
                Logger.error(`HTTP order error: ${error}`);
                return res.status(500).json({ error: 'Internal server error' });
            }
        });

        return new Promise((resolve, reject) => {
            this.server = app
                .listen(port, () => {
                    Logger.info(`HTTP listener on port ${port}`);
                    resolve();
                })
                .on('error', reject);
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}
