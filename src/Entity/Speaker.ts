import Entity from './Entity';
import SpotifyController from '../Controller/SpotifyController';
import Logger from '../Logger';

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

    async setState(property: string, value: string): Promise<void> {
        switch (property) {
            case 'volume':
                if (value === 'up') {
                    await this.raise_volume();
                } else if (value === 'down') {
                    await this.lower_volume();
                }
                break;
            case 'power':
                if (value === '1') {
                    await this.play(value);
                } else if (value === '0') {
                    await this.stop();
                }
                break;
            default:
                throw new Error(`Property ${property} not found`);
        }
    }
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
        Logger.info(
            `Entities Initialisation: Speaker '${speaker.name}' in Living room added`,
        );
    });
    return speakersArray;
}

export async function initTestSpeakers(): Promise<Entity[]> {
    return [new Speaker('Speaker', 201, 'Living room')];
}
