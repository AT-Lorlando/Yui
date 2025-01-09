import Entity from './Entity';
import SpotifyController from '../Controller/SpotifyController';
import Logger from '../Logger';
import { Response } from '../types/types';

export class Speaker extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    async stop(): Promise<Response> {
        try {
            console.log(`The speaker ${this.name} in ${this.room} is off.`);
            // Add code here to stop the speaker
            return { status: 'success', message: 'Speaker stopped' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async play(url: string): Promise<Response> {
        try {
            console.log(
                `The speaker ${this.name} in ${this.room} plays ${url}.`,
            );
            // Add code here to play the speaker
            return { status: 'success', message: 'Speaker playing' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async set_volume(volume: number): Promise<Response> {
        try {
            console.log(
                `The speaker ${this.name} in ${this.room} volume is set to ${volume}.`,
            );
            // Add code here to set the volume
            return { status: 'success', message: 'Volume set' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async lower_volume(): Promise<Response> {
        try {
            console.log(
                `The speaker ${this.name} in ${this.room} volume is lowered.`,
            );
            // Add code here to lower the volume
            return { status: 'success', message: 'Volume lowered' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async raise_volume(): Promise<Response> {
        try {
            console.log(
                `The speaker ${this.name} in ${this.room} volume is raised.`,
            );
            // Add code here to raise the volume
            return { status: 'success', message: 'Volume raised' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async setState(property: string, value: string): Promise<Response> {
        try {
            switch (property) {
                case 'volume':
                    if (value === 'up') {
                        return await this.raise_volume();
                    } else if (value === 'down') {
                        return await this.lower_volume();
                    }
                    throw new Error(
                        `Invalid value ${value} for property ${property}`,
                    );
                case 'power':
                    if (value === '1') {
                        return await this.play(value);
                    } else if (value === '0') {
                        return await this.stop();
                    }
                    throw new Error(
                        `Invalid value ${value} for property ${property}`,
                    );
                default:
                    throw new Error(`Property ${property} not found`);
            }
        } catch (error: any) {
            return { status: 'error', message: error.message };
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
