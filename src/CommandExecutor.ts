// Importez les classes d'entités
import { Entity } from './Entity';
import { logger } from './logger';
import http from 'http';
import env from './env';
import gpt3Request from './GPT3Request';
class CommandExecutor {
    entities: Entity[];
    gpt3Request: gpt3Request | undefined;

    constructor() {
        this.entities = [];
    }

    async init(entities: Entity[], gpt3Request: gpt3Request): Promise<void> {
        this.entities = entities;
        this.gpt3Request = gpt3Request;
    }

    private getEntity(entityID: number): Entity {
        const entity = this.entities.find((entity) => entity.id === entityID);
        if (entity === undefined) {
            throw new Error(`Entity with id ${entityID} not found`);
        }
        return entity;
    }

    turnoff(entityID: number): void {
        try {
            const entity = this.getEntity(entityID);
            entity.turnoff();
        } catch (error: any) {
            logger.error(error.message);
            throw error;
        }
    }

    turnon(entityID: number): void {
        try {
            const entity = this.getEntity(entityID);
            entity.turnon();
        } catch (error: any) {
            logger.error(error.message);
            throw error;
        }
    }

    test(entityID: number): void {
        try {
            const entity = this.getEntity(entityID);
            entity.test();
        } catch (error: any) {
            logger.error(error.message);
            throw error;
        }
    }

    async specialCommand(
        entityID: number,
        command: string,
        args?: [any],
    ): Promise<void> {
        try {
            const entity = this.getEntity(entityID);
            await entity.specialCommand(command, args);
        } catch (error: any) {
            logger.error(error.message);
            throw error;
        }
    }

    async backHome(): Promise<void> {
        logger.info('Going back home');
        this.PushNotification('Yui', 'Welcome back home !');
        try {
            this.turnon(4);
            this.turnon(5);
            this.turnon(12);
        } catch (error) {
            logger.error(`Error when back home: ${error}`);
        }
    }

    async leaveHome(): Promise<void> {
        logger.info('Leaving home');
        this.PushNotification('Yui', 'See you soon !');
        try {
            this.turnoff(4);
            this.turnoff(5);
            this.turnoff(12);
        } catch (error) {
            logger.error(`Error when leaving home: ${error}`);
        }
    }

    public PushNotification(pushTitle: string, pushMessage: string): void {
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

    public evalCommandFromOrder(command: string): void {
        if (this.gpt3Request == undefined) {
            throw new Error('GPT3Request is not initialized');
        }
        this.gpt3Request.evalCommandFromOrder(command);
    }
}

export default CommandExecutor;
