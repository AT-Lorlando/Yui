import type HueController from './HueController';
import type { EntityStore, LightEntity } from '@yui/shared';
import Logger from './logger';

export async function discoverLights(
    hue: HueController,
    store: EntityStore<LightEntity>,
): Promise<void> {
    const rooms = await hue.getAllGroups();
    const lightToRoom = new Map<string, string>();
    for (const room of rooms) {
        for (const lightId of room.lights) {
            lightToRoom.set(lightId, room.name);
        }
    }

    const rawLights = await hue.getAllLights();
    const now = new Date().toISOString();

    const entities: LightEntity[] = rawLights.map((light) => ({
        type: 'light' as const,
        id: light.id,
        name: light.name,
        room: lightToRoom.get(String(light.id)),
        lastDiscovered: now,
        state: {
            on: light.state.on ?? false,
            brightness: light.state.bri ?? 0,
            hue: light.state.hue,
            saturation: light.state.sat,
            reachable: light.state.reachable ?? false,
        },
    }));

    store.setAll(entities);
    store.saveSnapshot();
    Logger.info(`Hue discovery complete: ${entities.length} lights cached`);
}
