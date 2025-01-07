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

    async setState(property: string, value: string): Promise<void> {
        switch (property) {
            case 'state':
                if (value === 'unlock') {
                    await this.unlock();
                } else if (value === 'lock') {
                    await this.lock();
                }
                break;
            default:
                throw new Error(`Property ${property} not found`);
        }
    }
}
