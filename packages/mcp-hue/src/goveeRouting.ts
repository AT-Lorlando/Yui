/**
 * Routing rules for Govee devices — which ones a given command should hit.
 *
 * Two modes (see GoveeDeviceConfig in index.ts):
 *  - 'light'    : behaves like any Hue lamp (listed, room hooks, all-on/all-off).
 *  - 'ambiance' : opt-in only. Hidden from list_lights, never touched by a
 *                 room/all *on*, but always follows a room/all *off*.
 *                 It only lights up when addressed explicitly by name
 *                 (scenes, bindings, "allume la Govee Ambiance").
 *
 * The `room` field of an ambiance device is therefore an *off anchor*: it says
 * "when this room goes dark, go dark too", nothing more.
 */

export interface GoveeRoutable {
    id: string | number;
    room?: string;
}

/** Synthetic Govee ids are strings ("g:1"), Hue ids are numbers. */
export function isGovee(id: string | number): boolean {
    return typeof id === 'string' && id.startsWith('g:');
}

function sameRoom(a: string | undefined, b: string): boolean {
    return (a ?? '').toLowerCase().trim() === b.toLowerCase().trim();
}

/**
 * Govee devices a room-level command must apply to.
 * `turningOff` = the command is an explicit `on: false`.
 */
export function goveeTargetsForRoom<T extends GoveeRoutable>(
    lights: T[],
    room: string,
    ambianceIds: Set<string>,
    turningOff: boolean,
): T[] {
    return lights.filter(
        (l) =>
            isGovee(l.id) &&
            sameRoom(l.room, room) &&
            (turningOff || !ambianceIds.has(String(l.id))),
    );
}

/** Govee devices an all-lights command must apply to. */
export function goveeTargetsForAll<T extends GoveeRoutable>(
    lights: T[],
    ambianceIds: Set<string>,
    turningOff: boolean,
): T[] {
    return lights.filter(
        (l) => isGovee(l.id) && (turningOff || !ambianceIds.has(String(l.id))),
    );
}
