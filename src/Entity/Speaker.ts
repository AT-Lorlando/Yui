import Entity from './Entity';
import SpotifyController from '../Controller/SpotifyController';
import Logger from '../Logger';
import { Response } from '../types/types';

export class Speaker extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    /**
     * Stops the speaker.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async stop(): Promise<Response> {
        try {
            console.log(`The speaker ${this.name} in ${this.room} is off.`);
            // Add code here to stop the speaker
            return { status: 'success', message: 'Speaker stopped' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Plays a given URL on the speaker.
     * @param {string} url - The URL to play.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
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

    /**
     * Sets the volume of the speaker.
     * @param {number} volume - The desired volume level.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
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

    /**
     * Lowers the volume of the speaker.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
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

    /**
     * Raises the volume of the speaker.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
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
}

/**
 * Initializes the speakers using the Spotify controller.
 * @param {SpotifyController} spotifyController - The Spotify controller instance.
 * @returns {Promise<Entity[]>} - A promise that resolves to an array of speakers.
 */
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

/**
 * Initializes test speakers.
 * @returns {Promise<Entity[]>} - A promise that resolves to an array of test speakers.
 */
export async function initTestSpeakers(): Promise<Entity[]> {
    return [new Speaker('Speaker', 201, 'Living room')];
}
