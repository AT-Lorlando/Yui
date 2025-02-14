import Entity from './Entity';
import { Response } from '../types/types';

export class Door extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    /**
     * Locks the door.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async lock(): Promise<Response> {
        try {
            console.log(`The door is locked.`);
            // Add code here to lock the door
            return { status: 'success', message: 'Door locked' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Unlocks the door.
     * @returns {Promise<Response>} - The response indicating success or failure.
     */
    async unlock(): Promise<Response> {
        try {
            console.log(`The door is unlocked.`);
            // Add code here to unlock the door
            return { status: 'success', message: 'Door unlocked' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }
}

/**
 * Initializes test doors.
 * @returns {Promise<Entity[]>} - A promise that resolves to an array of test doors.
 */
export async function initTestDoors(): Promise<Entity[]> {
    return [new Door('Door', 401, 'Entrance')];
}
