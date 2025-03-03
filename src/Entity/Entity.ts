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

    __str__(): string {
        // constructor name
        const type = this.constructor.name;
        return `{type: ${type}, name: ${this.name}, id: ${this.id}, room: ${this.room}}`;
    }
}
