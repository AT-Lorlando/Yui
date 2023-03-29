export abstract class Entity {
    constructor(
        public name: string
    ) {}

    abstract shutdown(): void;
    abstract startup(): void;

    test() {
        console.log(`Test of ${this.name}`);
    }
}
  
export class Light extends Entity {

    constructor(name: string, public room: string) {
        super(name);
        
    }

    shutdown(): void {
        console.log(`Light ${this.name} in ${this.room} is off.`);
        // Ajoutez ici le code pour éteindre les lumières
    }

    startup(): void {
        console.log(`Light ${this.name} in ${this.room} is on.`);
        // Ajoutez ici le code pour allumer les lumières
    }
}

export class TV extends Entity {
    constructor(name: string, public room: string) {
        super(name);   
    }

    shutdown(): void {
        console.log(`The TV is off.`);
        // Ajoutez ici le code pour éteindre la télévision
    }

    startup(): void {
        console.log(`The TV is on.`);
        // Ajoutez ici le code pour allumer la télévision
    }
}

export class Speakers extends Entity {
    constructor(name: string, public room: string) {
        super(name);
    }

    shutdown(): void {
        console.log(`The speakers ${this.name} in ${this.room} are off.`);
        // Ajoutez ici le code pour éteindre les haut-parleurs
    }

    startup(): void {
        console.log(`The speakers ${this.name} in ${this.room} are on.`);
        // Ajoutez ici le code pour allumer les haut-parleurs
    }
}
  
  // Ajoutez d'autres classes pour d'autres entités ici
  