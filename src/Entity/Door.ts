import Entity from './Entity';

export class Door extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    async lock(): Promise<void> {
        console.log(`The door is open.`);
        // Ajoutez ici le code pour ouvrir la porte
    }

    async unlock(): Promise<void> {
        console.log(`The door is closed.`);
        // Ajoutez ici le code pour fermer la porte
    }
}
