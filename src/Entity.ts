import { logger } from './logger';
import * as fs from 'fs';

export abstract class Entity {
    constructor(public name: string, public id: number) {
        this.id = id;
    }

    abstract shutdown(): void;
    abstract turnon(): void;

    test() {
        logger.verbose(`Test of ${this.name}`);
    }
}

export class Light extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id);
    }

    shutdown(): void {
        console.log(`Light ${this.name} in ${this.room} is off.`);
        // Ajoutez ici le code pour éteindre les lumières
    }

    turnon(): void {
        console.log(`Light ${this.name} in ${this.room} is on.`);
        // Ajoutez ici le code pour allumer les lumières
    }

    set_luminosity(luminosity: number): void {
        console.log(
            `Light ${this.name} in ${this.room} luminosity is ${luminosity}.`,
        );
        // Ajoutez ici le code pour changer la luminosité des lumières
    }

    set_color(color: string): void {
        console.log(`Light ${this.name} in ${this.room} color is ${color}.`);
        // Ajoutez ici le code pour changer la couleur des lumières
    }

    lower_luminosity(): void {
        console.log(
            `Light ${this.name} in ${this.room} luminosity is lowered.`,
        );
        // Ajoutez ici le code pour baisser la luminosité des lumières
    }

    raise_luminosity(): void {
        console.log(`Light ${this.name} in ${this.room} luminosity is raised.`);
        // Ajoutez ici le code pour augmenter la luminosité des lumières
    }
}

export class TV extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id);
    }

    shutdown(): void {
        console.log(`The TV is off.`);
        // Ajoutez ici le code pour éteindre la télévision
    }

    turnon(): void {
        console.log(`The TV is on.`);
        // Ajoutez ici le code pour allumer la télévision
    }
}

export class Speakers extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id);
    }

    shutdown(): void {
        console.log(`The speakers ${this.name} in ${this.room} are off.`);
        // Ajoutez ici le code pour éteindre les haut-parleurs
    }

    turnon(): void {
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

    entities.lights.forEach(
        (light: { name: string; id: number; room: string }) => {
            entitiesArray.push(new Light(light.name, light.id, light.room));
            logger.info(`Light '${light.name}' in ${light.room} added`);
        },
    );
    entities.speakers.forEach(
        (speakers: { name: string; id: number; room: string }) => {
            entitiesArray.push(
                new Speakers(speakers.name, speakers.id, speakers.room),
            );
            logger.info(
                `Speakers '${speakers.name}' in ${speakers.room} added`,
            );
        },
    );
    entities.devices.forEach(
        (device: { name: string; id: number; room: string; type: string }) => {
            if (device.type === 'TV') {
                entitiesArray.push(new TV(device.name, device.id, device.room));
                logger.info(`TV '${device.name}' in ${device.room} added`);
            } else {
                logger.error(`Unknown device type: ${device.name}`);
            }
        },
    );

    return entitiesArray;
}
