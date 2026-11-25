import type NukiController from './NukiController';
import type { EntityStore, DoorEntity } from '@yui/shared';
import Logger from './logger';

export async function discoverDoors(
    nuki: NukiController,
    store: EntityStore<DoorEntity>,
): Promise<void> {
    const locks = await nuki.getAllLocks();
    const now = new Date().toISOString();

    const entities: DoorEntity[] = locks.map((lock: any) =>
        toEntity(lock, now),
    );

    store.setAll(entities);
    store.saveSnapshot();
    Logger.info(`Nuki discovery complete: ${entities.length} doors cached`);
}

/** Pur : une entrée de `/list` du bridge → entité porte. */
export function toEntity(lock: any, now: string): DoorEntity {
    return {
        type: 'door' as const,
        id: lock.nukiId,
        name: lock.name,
        lastDiscovered: now,
        deviceType: lock.deviceType ?? 0,
        state: {
            stateName: lock.lastKnownState?.stateName ?? 'unknown',
            batteryCritical: lock.lastKnownState?.batteryCritical ?? false,
            doorState: lock.lastKnownState?.doorsensorStateName,
        },
    };
}

// État frais (25/11/2026) : le store n'était lu qu'au démarrage et après nos
// propres actions — une porte ouverte à la clé, au bouton ou par l'app Nuki
// restait « verrouillée » pour Yui. Le bridge tient `lastKnownState` à jour
// (la serrure lui pousse chaque changement) : `list_doors` le relit, au plus
// une fois par `DOOR_STATE_TTL_MS`, sans réécrire le snapshot disque.
export const DOOR_STATE_TTL_MS = 4000;

let lastRefresh = 0;
let inFlight: Promise<void> | null = null;

/** Pur : faut-il relire le bridge ? */
export function isStale(
    last: number,
    now: number,
    ttl = DOOR_STATE_TTL_MS,
): boolean {
    return now - last >= ttl;
}

/** Relit l'état des portes si périmé. Échec → l'état connu reste servi. */
export async function refreshDoorStates(
    nuki: NukiController,
    store: EntityStore<DoorEntity>,
): Promise<void> {
    if (!isStale(lastRefresh, Date.now())) return;
    inFlight ??= (async () => {
        try {
            const now = new Date().toISOString();
            const locks = await nuki.getAllLocks();
            for (const lock of locks) {
                const fresh = toEntity(lock, now);
                if (store.getById(fresh.id))
                    store.updateState(fresh.id, fresh.state);
                else store.setAll([...store.getAll(), fresh]);
            }
            lastRefresh = Date.now();
        } catch (e) {
            Logger.warn(
                `[nuki] relecture d'état impossible (${
                    e instanceof Error ? e.message : String(e)
                }) — état connu servi`,
            );
        } finally {
            inFlight = null;
        }
    })();
    await inFlight;
}
