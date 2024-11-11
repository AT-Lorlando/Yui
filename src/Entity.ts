import { logger } from './logger';
import HueController from './HueController';
import SpotifyController from './SpotifyController';
import { Light } from './Entity/Light';
import { Speaker } from './Entity/Speaker';
// import { TV } from './Entity/Tv';
// import { Door } from './Entity/Door';

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

export async function initLights(
    hueController: HueController,
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
                        `Entities Initialisation: ${light.id}: Light '${light.name}' in ${group.name} added`,
                    );
                    return newLight;
                }),
            );
        });
    });
    return await Promise.all(lightPromises);
}

export async function initSpeakers(
    spotifyController: SpotifyController,
): Promise<Entity[]> {
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
    return speakersArray;
}

export async function initEntities(
    hueController: HueController,
    spotifyController: SpotifyController,
): Promise<Entity[]> {
    const lightsArray = await initLights(hueController);
    const speakersArray = await initSpeakers(spotifyController);

    const entitiesArray: Entity[] = [];
    entitiesArray.push(...lightsArray, ...speakersArray);

    if (entitiesArray === undefined || entitiesArray.length === 0) {
        throw new Error('Entities are undefined');
    }
    return entitiesArray;
}
