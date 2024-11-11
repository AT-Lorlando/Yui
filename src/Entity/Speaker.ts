import { Entity } from '../Entity';

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
