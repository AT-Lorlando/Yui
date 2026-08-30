/**
 * Résolution pure de `set_lights_bulk` — l'état cible d'une scène en une
 * action : « ces cibles comme ça, et (option) tout le reste éteint ».
 *
 * La résolution d'une cible est celle de set_lights (pièce d'abord, puis nom
 * exact, puis partiel) pour que le tool ne puisse pas viser autre chose que ce
 * que set_lights sait piloter.
 */

export interface BulkLight {
    id: string | number;
    name: string;
    room?: string;
}

export interface BulkEntry {
    target: string;
    on?: boolean;
    brightness?: number;
    color?: string;
    colorTemp?: number;
}

/** Ids couverts par une cible (pièce → toutes ses lampes ; sinon une lampe). */
export function resolveTargetIds(
    lights: BulkLight[],
    target: string,
): Array<string | number> {
    const lc = target.toLowerCase().trim();
    const byRoom = lights.filter((l) => (l.room ?? '').toLowerCase() === lc);
    if (byRoom.length) return byRoom.map((l) => l.id);
    const exact = lights.find((l) => l.name.toLowerCase() === lc);
    if (exact) return [exact.id];
    const partial = lights.find(
        (l) =>
            l.name.toLowerCase().includes(lc) ||
            lc.includes(l.name.toLowerCase()),
    );
    return partial ? [partial.id] : [];
}

/** Tous les ids touchés par les entrées (peu importe on/off). */
export function coveredIds(
    lights: BulkLight[],
    entries: BulkEntry[],
): Set<string | number> {
    const out = new Set<string | number>();
    for (const e of entries) {
        for (const id of resolveTargetIds(lights, e.target)) out.add(id);
    }
    return out;
}

/**
 * Ce que « éteindre le reste » doit couper : toutes les lampes non couvertes —
 * ambiance comprise (une extinction est toujours suivie).
 *
 * Garde du matériel partagé : deux devices Govee logiques peuvent être la même
 * lampe physique (même IP). Éteindre le canal non listé éteindrait aussi le
 * canal que la scène vient d'allumer — on saute donc tout device Govee dont
 * l'IP est partagée avec un device couvert.
 */
export function othersToTurnOff(
    lights: BulkLight[],
    covered: Set<string | number>,
    goveeIpById: Map<string, string>,
): { hueIds: number[]; goveeIds: string[] } {
    const coveredIps = new Set(
        [...covered]
            .map((id) => goveeIpById.get(String(id)))
            .filter((ip): ip is string => Boolean(ip)),
    );
    const hueIds: number[] = [];
    const goveeIds: string[] = [];
    const seenIps = new Set<string>();
    for (const l of lights) {
        if (covered.has(l.id)) continue;
        const ip = goveeIpById.get(String(l.id));
        if (ip) {
            // Un off par lampe physique suffit (plusieurs devices logiques
            // peuvent partager la même IP).
            if (!coveredIps.has(ip) && !seenIps.has(ip)) {
                seenIps.add(ip);
                goveeIds.push(String(l.id));
            }
        } else {
            hueIds.push(Number(l.id));
        }
    }
    return { hueIds, goveeIds };
}
