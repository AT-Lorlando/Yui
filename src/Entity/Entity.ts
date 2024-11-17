import Logger from '../Logger';

export default abstract class Entity {
    constructor(public name: string, public id: number, public room: string) {
        this.id = id;
        this.name = name;
        this.room = room;
    }

    test() {
        Logger.verbose(`Test of ${this.name}`);
    }
}
