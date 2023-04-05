// Importez les classes d'entités
import { Entity, Light, TV, Speakers } from './Entity';
import { logger } from './logger';
import { HueController } from './HueController';

class CommandExecutor {
    entities: Entity[];
    HueController: HueController;

    constructor() {
        this.entities = [];
        this.HueController = new HueController();
    }

    async init(entities: Entity[]): Promise<void> {
        this.entities = entities;
        await this.HueController.connect();
    }

    private getEntity(entityID: number): Entity {
        const entity = this.entities.find((entity) => entity.id === entityID);
        if (entity === undefined) {
            throw new Error(`Entity with id ${entityID} not found`);
        }
        return entity;
    }

    shutdown(entityID: number): void {
        try {
            const entity = this.getEntity(entityID);
            entity.shutdown();
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
}

export default CommandExecutor;
