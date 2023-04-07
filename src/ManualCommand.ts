import { logger } from './logger';
import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';

class ManualCommand {
    // constructor() {}

    async init(): Promise<void> {
        this.listen();
    }

    private listen(): void {
        const port = 3000;
        const app = express();
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));

        app.post('/command', (req: any, res: any) => {
            const ip =
                req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            if (fs.readFileSync('banned_ips.txt', 'utf8').includes(ip)) {
                logger.error(`Post from banned IP: ${ip}`);
                res.status(401).send('Banned IP');
                return;
            }
            const command = req.body.command;
            const password = req.body.password;
            if (password !== 'password') {
                logger.error('Wrong password');
                logger.error(`Banned IP: ${ip}`);
                // fs.appendFileSync('banned_ips.txt', `${ip}\n`);
                res.status(401).send('Wrong password');
                return;
            }
            logger.info(`Received command ${command}`);
            try {
                switch (command) {
                    case 'turnoff':
                        logger.info('Shutting down');
                        res.status(200).send('Shutting down');
                        this.turnoff();
                        break;
                    case 'backhome':
                        logger.info('Going back home');
                        res.status(200).send('Going back home');
                        this.backHome();
                        break;
                    case 'leavehome':
                        logger.info('Leaving home');
                        res.status(200).send('Leaving home');
                        this.leaveHome();
                        break;
                    default:
                        // Gpt 3 handle this
                        res.status(200).send('Command received');
                        return;
                }
            } catch (error: any) {
                logger.error(error.message);
                res.status(500).send(error.message);
                return;
            }
        });

        app.listen(port, () => {
            logger.info(`Listening on port ${port}`);
        });
    }

    async backHome(): Promise<void> {
        logger.info('Going back home');
        // Code when i'm back home
    }

    async leaveHome(): Promise<void> {
        logger.info('Leaving home');
        // Code when i'm leaving home
    }

    async turnoff(): Promise<void> {
        logger.info('Shutting down');
        // Code when Yui is shutting down
    }
}
export default ManualCommand;
