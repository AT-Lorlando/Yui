import { logger } from './logger';
import express from 'express';
import * as bodyParser from 'body-parser';
import * as fs from 'fs';
import gpt3Request from './GPT3Request';
import CommandExecutor from './CommandExecutor';
import env from './env';
import http from 'http';

class ManualCommand {
    private commandExecutor: CommandExecutor | undefined;

    async init(
        gpt3Request: gpt3Request,
        commandExecutor: CommandExecutor,
    ): Promise<void> {
        this.listenOnWeb(gpt3Request);
        this.listenOnStdin(gpt3Request);
        this.commandExecutor = commandExecutor;
    }

    private async listenOnWeb(gpt3Request: gpt3Request): Promise<void> {
        const port = 3000;
        const app = express();
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));
        if (!fs.existsSync('banned_ips.txt')) {
            fs.writeFileSync('banned_ips.txt', '');
        }
        app.post('/command', (req: any, res: any) => {
            const ip =
                req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            try {
                if (fs.readFileSync('banned_ips.txt', 'utf8').includes(ip)) {
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
                this.PushNotification(
                    'Yui - Alert',
                    'Unauthorized request, IP banned' + ip,
                );
                return;
            }
            const command = req.body.command;
            logger.info(`Received command ${command.replace('\n', '')}`);
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
                        gpt3Request.evalCommandFromOrder(command);
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

    private async listenOnStdin(gpt3Request: gpt3Request): Promise<void> {
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (text: string) => {
            logger.info(`Received command ${text}`);
            try {
                gpt3Request.evalCommandFromOrder(text);
            } catch (error) {
                logger.error(
                    `Error during the execution of the command: ${error}`,
                );
            }
        });
    }

    async backHome(): Promise<void> {
        logger.info('Going back home');
        this.PushNotification('Yui', 'Welcome back home !');
        try {
            this.commandExecutor?.turnon(4);
            this.commandExecutor?.turnon(5);
            this.commandExecutor?.turnon(12);
        } catch (error) {
            logger.error(`Error when back home: ${error}`);
        }
    }

    async leaveHome(): Promise<void> {
        logger.info('Leaving home');
        this.PushNotification('Yui', 'See you soon !');
        try {
            this.commandExecutor?.turnoff(4);
            this.commandExecutor?.turnoff(5);
            this.commandExecutor?.turnoff(12);
        } catch (error) {
            logger.error(`Error when leaving home: ${error}`);
        }
    }

    async turnoff(): Promise<void> {
        logger.info('Shutting down');
        // Code when Yui is shutting down
    }

    private PushNotification(pushTitle: string, pushMessage: string): void {
        const apiKey = env.NOTIFYMYDEVICE_API_KEY;
        if (apiKey !== undefined) {
            http.get(
                `http://www.notifymydevice.com/push?ApiKey=${apiKey}&PushTitle=${pushTitle}&PushText=${pushMessage}`,
                (resp) => {
                    resp.on('end', () => {
                        logger.info('Push notification sent');
                    });
                },
            );
        }
    }
}
export default ManualCommand;
