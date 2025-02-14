import Entity from './Entity';
import { Response } from '../types/types';

export class TV extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    /**
     * Turns off the TV.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async turn_off(): Promise<Response> {
        try {
            console.log(`The TV is off.`);
            // Add code here to turn off the TV
            return { status: 'success', message: 'TV turned off' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Turns on the TV.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async turn_on(): Promise<Response> {
        try {
            console.log(`The TV is on.`);
            // Add code here to turn on the TV
            return { status: 'success', message: 'TV turned on' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Sets the TV channel.
     * @param {number} channel - The desired channel number.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async set_channel(channel: number): Promise<Response> {
        try {
            console.log(`The TV channel is set to ${channel}.`);
            // Add code here to set the channel
            return { status: 'success', message: 'Channel set' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Sets the TV volume.
     * @param {number} volume - The desired volume level.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async set_volume(volume: number): Promise<Response> {
        try {
            console.log(`The TV volume is set to ${volume}.`);
            // Add code here to set the volume
            return { status: 'success', message: 'Volume set' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Lowers the TV volume.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async lower_volume(): Promise<Response> {
        try {
            console.log(`The TV volume is lowered.`);
            // Add code here to lower the volume
            return { status: 'success', message: 'Volume lowered' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Raises the TV volume.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async raise_volume(): Promise<Response> {
        try {
            console.log(`The TV volume is raised.`);
            // Add code here to raise the volume
            return { status: 'success', message: 'Volume raised' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }
}

/**
 * Initializes test TVs.
 * @returns {Promise<Entity[]>} - A promise that resolves to an array of test TVs.
 */
export async function initTestTVs(): Promise<Entity[]> {
    return [new TV('TV', 301, 'Living room')];
}
