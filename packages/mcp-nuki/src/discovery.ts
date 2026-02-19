import type NukiController from './NukiController';
import type { EntityStore, DoorEntity } from '@yui/shared';
import Logger from './logger';

export async function discoverDoors(
    nuki: NukiController,
    store: EntityStore<DoorEntity>,
): Promise<void> {
    const locks = await nuki.getAllLocks();
    const now = new Date().toISOString();

    const entities: DoorEntity[] = locks.map((lock: any) => ({
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
    }));

    store.setAll(entities);
    store.saveSnapshot();
    Logger.info(`Nuki discovery complete: ${entities.length} doors cached`);
}
