import { logger } from './logger';
import * as fs from 'fs';
import HueController from './HueController';
import SpotifyController from './SpotifyController';

export abstract class Entity {
    constructor(public name: string, public id: number, public room: string) {
        this.id = id;
        this.name = name;
        this.room = room;
    }

    test() {
        logger.verbose(`Test of ${this.name}`);
    }
}

export class Light extends Entity {
    private hueController: HueController;
    constructor(
        name: string,
        public id: number,
        public room: string,
        hueController: HueController,
    ) {
        super(name, id, room);
        this.hueController = hueController;
    }

    async turnoff(): Promise<void> {
        await this.hueController
            .setLightState(this.id, false)
            .catch((error) => {
                throw error;
            });
    }

    async turnon(): Promise<void> {
        await this.hueController.setLightState(this.id, true).catch((error) => {
            throw error;
        });
    }

    async set_luminosity(luminosity: number): Promise<void> {
        const state = await this.hueController.getLightState(this.id);
        if (state.on === false) {
            await this.hueController.setLightState(this.id, true);
        }
        await this.hueController
            .setLightBrightness(this.id, luminosity)
            .catch((error) => {
                throw error;
            });
    }

    async set_color(color: string): Promise<void> {
        await this.hueController
            .setLightColor(this.id, color)
            .catch((error) => {
                throw error;
            });
    }

    async lower_luminosity(): Promise<void> {
        const state = await this.hueController
            .getLightState(this.id)
            .catch((error) => {
                throw error;
            });
        const luminosity = state.bri;
        await this.hueController
            .setLightBrightness(this.id, luminosity - 10)
            .catch((error) => {
                throw error;
            });
    }

    async raise_luminosity(): Promise<void> {
        const state = await this.hueController
            .getLightState(this.id)
            .catch((error) => {
                throw error;
            });
        const luminosity = state.bri;
        await this.hueController
            .setLightBrightness(this.id, luminosity + 10)
            .catch((error) => {
                throw error;
            });
    }
}

export class TV extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    async specialCommand(command: string, args?: [any]): Promise<void> {
        switch (command) {
            case 'set_channel':
                if (args === undefined) {
                    throw new Error(`Missing argument for command ${command}`);
                }
                await this.set_channel(args[0]);
                break;
            case 'set_volume':
                if (args === undefined) {
                    throw new Error(`Missing argument for command ${command}`);
                }
                await this.set_volume(args[0]);
                break;
            case 'lower_volume':
                await this.lower_volume();
                break;
            case 'raise_volume':
                await this.raise_volume();
                break;
            default:
                throw new Error(`Command ${command} not supported`);
        }
    }

    async turnoff(): Promise<void> {
        console.log(`The TV is off.`);
        // Ajoutez ici le code pour éteindre la télévision
    }

    async turnon(): Promise<void> {
        console.log(`The TV is on.`);
        // Ajoutez ici le code pour allumer la télévision
    }

    async set_channel(channel: number): Promise<void> {
        console.log(`The TV channel is set to ${channel}.`);
        // Ajoutez ici le code pour changer de chaîne
    }

    async set_volume(volume: number): Promise<void> {
        console.log(`The TV volume is set to ${volume}.`);
        // Ajoutez ici le code pour changer le volume
    }

    async lower_volume(): Promise<void> {
        console.log(`The TV volume is lowered.`);
        // Ajoutez ici le code pour baisser le volume
    }

    async raise_volume(): Promise<void> {
        console.log(`The TV volume is raised.`);
        // Ajoutez ici le code pour augmenter le volume
    }
}

export class Speaker extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    async stop(): Promise<void> {
        console.log(`The speaker ${this.name} in ${this.room} are off.`);
        // Ajoutez ici le code pour éteindre les haut-parleurs
    }

    async play(url: string): Promise<void> {
        console.log(`The speaker ${this.name} in ${this.room} play ${url}.`);
        // Ajoutez ici le code pour allumer les haut-parleurs
    }

    async set_volume(volume: number): Promise<void> {
        console.log(
            `The speaker ${this.name} in ${this.room} volume is set to ${volume}.`,
        );
        // Ajoutez ici le code pour changer le volume
    }

    async lower_volume(): Promise<void> {
        console.log(
            `The speaker ${this.name} in ${this.room} volume is lowered.`,
        );
        // Ajoutez ici le code pour baisser le volume
    }

    async raise_volume(): Promise<void> {
        console.log(
            `The speaker ${this.name} in ${this.room} volume is raised.`,
        );
        // Ajoutez ici le code pour augmenter le volume
    }
}

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

// Ajoutez d'autres classes pour d'autres entités ici

export async function testEntities(entities: Entity[]) {
    entities.forEach((entity) => {
        entity.test();
    });
}

async function initEntitiesFromJson(
    hueController: HueController,
): Promise<Entity[]> {
    // Read from entities.json and create the entities

    // Return an array of entities

    const entitiesArray: Entity[] = [];
    const entitiesJson = fs.readFileSync('entities.json', 'utf8');
    const entities = JSON.parse(entitiesJson);

    entities.lights.forEach(
        (light: { name: string; id: number; room: string }) => {
            entitiesArray.push(
                new Light(light.name, light.id, light.room, hueController),
            );
            logger.info(
                `Entities Initialisation: Light '${light.name}' in ${light.room} added`,
            );
        },
    );
    entities.speaker.forEach(
        (speaker: { name: string; id: number; room: string }) => {
            entitiesArray.push(
                new Speaker(speaker.name, speaker.id, speaker.room),
            );
            logger.info(
                `Entities Initialisation: Speaker '${speaker.name}' in ${speaker.room} added`,
            );
        },
    );
    entities.devices.forEach(
        (device: { name: string; id: number; room: string; type: string }) => {
            if (device.type === 'TV') {
                entitiesArray.push(new TV(device.name, device.id, device.room));
                logger.info(
                    `Entities Initialisation: TV '${device.name}' in ${device.room} added`,
                );
            } else {
                logger.error(`Unknown device type: ${device.name}`);
            }
        },
    );
    if (entitiesArray === undefined || entitiesArray.length === 0) {
        throw new Error('Entities are undefined');
    }
    return entitiesArray;
}

async function initEntitiesFromAPI(
    hueController: HueController,
    spotifyController: SpotifyController,
): Promise<Entity[]> {
    const lightsGroups = await hueController.getGroupsByType('Room');

    const lightPromises: Promise<Entity>[] = [];

    lightsGroups.forEach((group) => {
        group.lights.forEach((lightID: number) => {
            lightPromises.push(
                hueController.getLightById(lightID).then((light) => {
                    const newLight = new Light(
                        light.name,
                        light.id,
                        group.name,
                        hueController,
                    );
                    logger.info(
                        `Entities Initialisation: Light '${light.name}' in ${group.name} added`,
                    );
                    return newLight;
                }),
            );
        });
    });

    const speakers = await spotifyController.getDevices();
    const speakersArray = [] as Entity[];
    speakers.forEach((speaker: any) => {
        speakersArray.push(
            new Speaker(speaker.name, speaker.host, 'Living room'),
        );
        logger.info(
            `Entities Initialisation: Speaker '${speaker.name}' in Living room added`,
        );
    });

    // Attendez que toutes les Promesses soient résolues
    const lightsArray = await Promise.all(lightPromises);

    const entitiesArray: Entity[] = [];

    entitiesArray.push(...lightsArray, ...speakersArray);
    if (entitiesArray === undefined || entitiesArray.length === 0) {
        throw new Error('Entities are undefined');
    }
    return entitiesArray;
}

export async function initEntities(
    hueController: HueController,
    spotifyController: SpotifyController,
    fromAPI = true,
) {
    try {
        if (fromAPI) {
            return await initEntitiesFromAPI(hueController, spotifyController);
        } else {
            return await initEntitiesFromJson(hueController);
        }
    } catch (error) {
        logger.error(
            `Error during the initialisation of entities from API: ${error}`,
        );
        throw new Error('Error during the initialisation of entities from API');
    }
}
