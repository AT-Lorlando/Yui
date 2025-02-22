import NukiController from '../Controller/NukiController';
import Entity from './Entity';
import Logger from '../Logger';
import { Response } from '../types/types';

export class Door extends Entity {
    constructor(
        public name: string,
        public id: number,
        public room: string,
        private nukiController: NukiController,
        private deviceType = 4,
    ) {
        super(name, id, room);
    }

    /**
     * Verrouille la porte (lock).
     * @returns {Promise<Response>} - Le statut de l'opération.
     */
    async lock_door(): Promise<Response> {
        try {
            await this.nukiController.lock(this.id, this.deviceType);
            return { status: 'success', message: 'Door locked' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    /**
     * Déverrouille la porte (unlock).
     * @returns {Promise<Response>} - Le statut de l'opération.
     */
    async unlock_door(): Promise<Response> {
        try {
            await this.nukiController.unlock(this.id, this.deviceType);
            return { status: 'success', message: 'Door unlocked' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }
    /**
     * Récupère l'état de la porte (locked/unlocked, batterie, etc.)
     * @returns {Promise<Response>} - Le statut (locked/unlocked) ou erreur.
     */
    async get_door_state(): Promise<Response> {
        try {
            const state = await this.nukiController.getLockState(
                this.id,
                this.deviceType,
            );
            return {
                status: 'success',
                message: `Door state: ${state.stateName}`,
                content: state,
            };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }
}

/**
 * Initialise toutes les portes en s’appuyant sur la liste renvoyée par la Nuki API.
 * @param {NukiController} nukiController - Le contrôleur Nuki initialisé.
 * @returns {Promise<Entity[]>} - Les entités créées.
 */
export async function initDoors(
    nukiController: NukiController,
): Promise<Entity[]> {
    const doors: Entity[] = [];
    try {
        const locks = await nukiController.getAllLocks();
        locks.forEach((lock) => {
            // lock.nukiId, lock.name, lock.deviceType, etc.
            const door = new Door(
                lock.name || 'Unnamed Door',
                lock.nukiId,
                lock.name,
                nukiController,
                lock.deviceType || 4, // Par défaut 4 = Smart Lock
            );
            Logger.info(
                `Entities Initialisation: ${lock.nukiId}: Door '${lock.name}' added`,
            );
            doors.push(door);
        });
    } catch (error: any) {
        Logger.error('Error initializing doors:', error);
    }
    return doors;
}

/**
 * Initialise un jeu de portes fictives pour les tests.
 * @param {NukiController} nukiController - Le contrôleur Nuki initialisé.
 * @returns {Promise<Entity[]>} - Les entités "Door" créées.
 */
export async function initTestDoors(
    nukiController: NukiController,
): Promise<Entity[]> {
    // Exemple d’entités de test, adaptables selon tes besoins
    return [
        new Door('Main Entrance', 201, 'Entrance', nukiController, 4),
        new Door('Garage Door', 202, 'Garage', nukiController, 4),
    ];
}
