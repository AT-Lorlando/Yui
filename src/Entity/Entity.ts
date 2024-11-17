import { logger } from '../logger';

export default abstract class Entity {
    constructor(public name: string, public id: number, public room: string) {
        this.id = id;
        this.name = name;
        this.room = room;
    }

    test() {
        logger.verbose(`Test of ${this.name}`);
    }
}
