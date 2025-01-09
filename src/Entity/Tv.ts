import Entity from './Entity';
import { Response } from '../types/types';

export class TV extends Entity {
    constructor(name: string, public id: number, public room: string) {
        super(name, id, room);
    }

    async specialCommand(command: string, args?: [any]): Promise<Response> {
        try {
            switch (command) {
                case 'set_channel':
                    if (args === undefined) {
                        throw new Error(
                            `Missing argument for command ${command}`,
                        );
                    }
                    return await this.set_channel(args[0]);
                case 'set_volume':
                    if (args === undefined) {
                        throw new Error(
                            `Missing argument for command ${command}`,
                        );
                    }
                    return await this.set_volume(args[0]);
                case 'lower_volume':
                    return await this.lower_volume();
                case 'raise_volume':
                    return await this.raise_volume();
                default:
                    throw new Error(`Command ${command} not supported`);
            }
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async turnoff(): Promise<Response> {
        try {
            console.log(`The TV is off.`);
            // Add code here to turn off the TV
            return { status: 'success', message: 'TV turned off' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async turnon(): Promise<Response> {
        try {
            console.log(`The TV is on.`);
            // Add code here to turn on the TV
            return { status: 'success', message: 'TV turned on' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async set_channel(channel: number): Promise<Response> {
        try {
            console.log(`The TV channel is set to ${channel}.`);
            // Add code here to set the channel
            return { status: 'success', message: 'Channel set' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async set_volume(volume: number): Promise<Response> {
        try {
            console.log(`The TV volume is set to ${volume}.`);
            // Add code here to set the volume
            return { status: 'success', message: 'Volume set' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async lower_volume(): Promise<Response> {
        try {
            console.log(`The TV volume is lowered.`);
            // Add code here to lower the volume
            return { status: 'success', message: 'Volume lowered' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async raise_volume(): Promise<Response> {
        try {
            console.log(`The TV volume is raised.`);
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
                    return await this.set_volume(parseInt(value, 10));
                case 'channel':
                    return await this.set_channel(parseInt(value, 10));
                case 'power':
                    if (value === '1') {
                        return await this.turnon();
                    } else if (value === '0') {
                        return await this.turnoff();
                    }
                    throw new Error(
                        `Value ${value} not supported for property ${property}`,
                    );
                default:
                    throw new Error(`Property ${property} not found`);
            }
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }
}

export async function initTestTVs(): Promise<Entity[]> {
    return [new TV('TV', 301, 'Living room')];
}
