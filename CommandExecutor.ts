// Importez les classes d'entités
import { Entity, Light, TV, Speakers } from './Entity';

class CommandExecutor {
    shutdown(entity: Entity): void {
        entity.shutdown();
    }

    startup(entity: Entity): void {
        entity.startup();
    }
}

export default CommandExecutor;
