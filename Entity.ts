import { logger } from './logger';
import * as fs from 'fs';

export abstract class Entity {
    constructor(public name: string) {}

    abstract shutdown(): void;
    abstract startup(): void;

    test() {
        console.log(`Test of ${this.name}`);
    }
}

export class Light extends Entity {
    constructor(name: string, public room: string) {
        super(name);
    }

    shutdown(): void {
        console.log(`Light ${this.name} in ${this.room} is off.`);
        // Ajoutez ici le code pour éteindre les lumières
    }

    startup(): void {
        console.log(`Light ${this.name} in ${this.room} is on.`);
        // Ajoutez ici le code pour allumer les lumières
    }
}

export class TV extends Entity {
    constructor(name: string, public room: string) {
        super(name);
    }

    shutdown(): void {
        console.log(`The TV is off.`);
        // Ajoutez ici le code pour éteindre la télévision
    }

    startup(): void {
        console.log(`The TV is on.`);
        // Ajoutez ici le code pour allumer la télévision
    }
}

export class Speakers extends Entity {
    constructor(name: string, public room: string) {
        super(name);
    }

    shutdown(): void {
        console.log(`The speakers ${this.name} in ${this.room} are off.`);
        // Ajoutez ici le code pour éteindre les haut-parleurs
    }

    startup(): void {
        console.log(`The speakers ${this.name} in ${this.room} are on.`);
        // Ajoutez ici le code pour allumer les haut-parleurs
    }
}

// Ajoutez d'autres classes pour d'autres entités ici

export async function testEntities(entities: Entity[]) {
    entities.forEach((entity) => {
        entity.test();
    });
}

export async function initEntities() {
    // Read from entities.json and create the entities

    // Return an array of entities

    const entitiesArray: Entity[] = [];
    const entitiesJson = fs.readFileSync('entities.json', 'utf8');
    const entities = JSON.parse(entitiesJson);
    entities.lights.forEach((light: any) => {
        entitiesArray.push(new Light(light.name, light.room));
        logger.info(`Light '${light.name}' in ${light.room} added`);
    });
    entities.speakers.forEach((speakers: any) => {
        entitiesArray.push(new Speakers(speakers.name, speakers.room));
        logger.info(`Speakers '${speakers.name}' in ${speakers.room} added`);
    });
    entities.devices.forEach((device: any) => {
        if (device.type === 'TV') {
            entitiesArray.push(new TV(device.name, device.room));
            logger.info(`TV '${device.name}' in ${device.room} added`);
        } else {
            logger.error(`Unknown device type: ${device.name}`);
        }
    });

    return entitiesArray;
}
