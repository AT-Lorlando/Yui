import Entity from './Entity';
import { Response } from '../types/types';

export class Door extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    async lock(): Promise<Response> {
        try {
            console.log(`The door is locked.`);
            // Add code here to lock the door
            return { status: 'success', message: 'Door locked' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async unlock(): Promise<Response> {
        try {
            console.log(`The door is unlocked.`);
            // Add code here to unlock the door
            return { status: 'success', message: 'Door unlocked' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async setState(property: string, value: string): Promise<Response> {
        try {
            switch (property) {
                case 'lock':
                    if (value === '0') {
                        return await this.unlock();
                    } else if (value === '1') {
                        return await this.lock();
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

export async function initTestDoors(): Promise<Entity[]> {
    return [new Door('Door', 401, 'Entrance')];
}
