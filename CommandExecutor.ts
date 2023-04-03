// Importez les classes d'entités
import { Entity, Light, TV, Speakers } from './Entity';
import { logger } from './logger';

class CommandExecutor {
    entities: Entity[];
    constructor() {
        this.entities = [];
    }

    async init(entities: Entity[]): Promise<void> {
        this.entities = entities;
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
        }
    }

    turnon(entityID: number): void {
        try {
            const entity = this.getEntity(entityID);
            entity.turnon();
        } catch (error: any) {
            logger.error(error.message);
        }
    }

    test(entityID: number): void {
        try {
            const entity = this.getEntity(entityID);
            entity.test();
        } catch (error: any) {
            logger.error(error.message);
        }
    }
}

export default CommandExecutor;
