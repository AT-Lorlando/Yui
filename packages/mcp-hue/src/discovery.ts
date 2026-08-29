import type HueController from './HueController';
import type { EntityStore, LightEntity } from '@yui/shared';
import Logger from './logger';

/**
 * Recharge les lampes Hue depuis le bridge.
 *
 * Les entités non-Hue déjà connues (Govee, id "g:N") sont conservées : elles
 * n'existent pas côté bridge, et un `setAll` brut les faisait disparaître du
 * store jusqu'au prochain démarrage.
 */
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
            // Le bridge renvoie bri en 0–254, alors que le store (et tout ce
            // qui le lit : app, scènes, set_brightness) travaille en 0–100.
            // Sans conversion, une lampe relue depuis le bridge s'affichait
            // "254 %" et un « Restaurer » renvoyait 254 comme pourcentage.
            brightness: Math.round(((light.state.bri ?? 0) / 254) * 100),
            hue: light.state.hue,
            saturation: light.state.sat,
            reachable: light.state.reachable ?? false,
        },
    }));

    const foreign = store
        .getAll()
        .filter((l) => typeof l.id === 'string' && l.id.startsWith('g:'));
    store.setAll([...entities, ...foreign]);
    store.saveSnapshot();
    Logger.info(
        `Hue discovery complete: ${entities.length} lights cached` +
            (foreign.length ? ` (+${foreign.length} non-Hue conservées)` : ''),
    );
}
