import Entity from './Entity';

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

    async setState(property: string, value: string): Promise<void> {
        switch (property) {
            case 'volume':
                await this.set_volume(parseInt(value, 10));
                break;
            case 'channel':
                await this.set_channel(parseInt(value, 10));
                break;
            case 'power':
                if (value === '0') {
                    await this.turnon();
                } else if (value === '1') {
                    await this.turnoff();
                }
                break;
            default:
                throw new Error(`Property ${property} not found`);
        }
    }
}

export async function initTestTVs(): Promise<Entity[]> {
    return [new TV('TV', 301, 'Living room')];
}
