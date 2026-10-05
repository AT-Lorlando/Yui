/**
 * Traduction des événements du flux SSE Hue v2 en patchs d'état pour le store.
 *
 * Le bridge pousse ses changements en v2 : ressources identifiées par UUID,
 * luminosité en pourcentage. Le store, lui, indexe les lampes par id v1
 * numérique (celui de node-hue-api). Le pont entre les deux est `id_v1`
 * ("/lights/19"), exposé par /clip/v2/resource/light.
 *
 * Cette partie est volontairement pure : elle ne fait ni réseau ni I/O, donc
 * elle se teste sans bridge.
 */

import { xyToHueSat, mirekToKelvin, type ColorMode } from './colour';

export interface LightStatePatch {
    id: number;
    on?: boolean;
    brightness?: number; // 0–100, l'échelle du store
    hue?: number; // 0–65535
    saturation?: number; // 0–254
    ct?: number; // kelvin
    colormode?: ColorMode;
}

/** Ressource /clip/v2/resource/light, réduite à ce qui nous sert. */
export interface HueV2LightResource {
    id: string;
    id_v1?: string;
    owner?: { rid: string; rtype: string };
}

export interface HueV2Event {
    type?: string;
    data?: Array<{
        id: string;
        type?: string;
        on?: { on?: boolean };
        dimming?: { brightness?: number };
        color?: { xy?: { x: number; y: number } };
        color_temperature?: { mirek?: number | null; mirek_valid?: boolean };
    }>;
}

/** "/lights/19" → 19 */
export function idV1ToNumber(idV1: string | undefined): number | undefined {
    const m = /\/lights\/(\d+)/.exec(idV1 ?? '');
    return m ? Number(m[1]) : undefined;
}

/** UUID v2 → id v1 numérique, pour toutes les lampes connues du bridge. */
export function buildLightIdMap(
    resources: HueV2LightResource[],
): Map<string, number> {
    const map = new Map<string, number>();
    for (const r of resources ?? []) {
        const id = idV1ToNumber(r.id_v1);
        if (r.id && id !== undefined) map.set(r.id, id);
    }
    return map;
}

/**
 * Patchs à appliquer pour un lot d'événements SSE.
 *
 * Un événement ne porte que ce qui a changé : allumer une lampe envoie `on`
 * sans `dimming`. Les champs absents restent donc absents du patch — le store
 * conserve sa valeur précédente plutôt que de la remettre à zéro.
 */
export function eventsToPatches(
    events: HueV2Event[],
    idMap: Map<string, number>,
): LightStatePatch[] {
    const patches = new Map<number, LightStatePatch>();
    for (const ev of events ?? []) {
        if (ev.type && ev.type !== 'update') continue;
        for (const item of ev.data ?? []) {
            if (item.type !== 'light') continue;
            const id = idMap.get(item.id);
            if (id === undefined) continue;
            const patch: LightStatePatch = patches.get(id) ?? { id };
            if (item.on?.on !== undefined) patch.on = item.on.on;
            if (item.dimming?.brightness !== undefined) {
                patch.brightness = Math.round(item.dimming.brightness);
            }
            // Couleur : le bridge pousse du xy (jamais hue/sat) ; on le
            // ramène au format du store. Un changement de couleur arrive
            // avec un `color_temperature` invalidé dans le même item, un
            // passage en blanc avec un mirek valide ET le xy du blanc : le
            // blanc prime, le xy est relevé quand même (le bridge garde
            // hue/sat en mode ct, comme la v1).
            const xy = item.color?.xy;
            if (xy && typeof xy.x === 'number' && typeof xy.y === 'number') {
                const { hue, sat } = xyToHueSat(xy.x, xy.y);
                patch.hue = hue;
                patch.saturation = sat;
                patch.colormode = 'xy';
            }
            const ctK =
                item.color_temperature?.mirek_valid === true
                    ? mirekToKelvin(item.color_temperature.mirek)
                    : undefined;
            if (ctK !== undefined) {
                patch.ct = ctK;
                patch.colormode = 'ct';
            }
            // Un lot peut contenir plusieurs événements pour la même lampe
            // (on puis dimming) : ils se cumulent, le dernier gagne par champ.
            if (Object.keys(patch).length > 1) {
                patches.set(id, patch);
            }
        }
    }
    return [...patches.values()];
}

/** Découpe un flux SSE en lots d'événements ; renvoie le reliquat non terminé. */
export function parseSseChunk(buffer: string): {
    events: HueV2Event[];
    remainder: string;
} {
    const parts = buffer.split('\n\n');
    const remainder = parts.pop() ?? '';
    const events: HueV2Event[] = [];
    for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
            const parsed = JSON.parse(line.slice(6));
            if (Array.isArray(parsed)) events.push(...parsed);
        } catch {
            // Trame illisible : on l'ignore plutôt que de casser le flux.
        }
    }
    return { events, remainder };
}
