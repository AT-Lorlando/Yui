/**
 * Exécution de `set_lights_bulk` : les entrées Hue partent EN PARALLÈLE (une
 * scène de 7 entrées s'allumait lampe par lampe quand chacune attendait la
 * précédente), plafonnées à BULK_HUE_CONCURRENCY écritures en vol (le bridge
 * tolère ~10 écritures/s), les entrées Govee ensuite, une par une (UDP, rampe
 * de couleur logicielle — cf. goveeFade). Une lampe en échec n'empêche
 * jamais les autres : son erreur rejoint le texte rendu.
 */

import type { BulkEntry } from './bulkStates';

/** Transition par défaut d'une entrée bulk : les lampes montent ensemble. */
export const BULK_DEFAULT_TRANSITION_MS = 400;

/** Écritures Hue simultanées au plus. */
export const BULK_HUE_CONCURRENCY = 6;

/**
 * Transition d'une entrée : la sienne si numérique, sinon celle de l'action,
 * sinon le défaut. Une valeur non numérique est ignorée (jamais de
 * `transitiontime(NaN)`).
 */
export function bulkTransitionMs(
    actionValue: unknown,
    entryValue?: unknown,
): number {
    for (const v of [entryValue, actionValue]) {
        if (v === undefined || v === null || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return BULK_DEFAULT_TRANSITION_MS;
}

export async function runBulkEntries(
    entries: BulkEntry[],
    isGoveeEntry: (e: BulkEntry) => boolean,
    apply: (e: BulkEntry) => Promise<string>,
    concurrency: number = BULK_HUE_CONCURRENCY,
): Promise<string[]> {
    const results: string[] = new Array(entries.length);
    const fail = (e: BulkEntry, err: unknown) =>
        `${e.target} : échec (${
            err instanceof Error ? err.message : String(err)
        })`;
    const safeApply = (e: BulkEntry): Promise<string> => {
        try {
            return apply(e);
        } catch (err) {
            return Promise.reject(err);
        }
    };

    // 1. Le lot Hue est lancé (pool borné, premiers départs synchrones)…
    const hue = entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !isGoveeEntry(e));
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < hue.length) {
            const { e, i } = hue[next++];
            try {
                results[i] = await safeApply(e);
            } catch (err) {
                results[i] = fail(e, err);
            }
        }
    };
    const hueBatch = Promise.all(
        Array.from(
            { length: Math.min(Math.max(1, concurrency), hue.length) },
            () => worker(),
        ),
    );

    // 2. …puis les Govee, en séquence, pendant que les Hue fondent.
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!isGoveeEntry(e)) continue;
        try {
            results[i] = await safeApply(e);
        } catch (err) {
            results[i] = fail(e, err);
        }
    }

    await hueBatch;
    return results;
}
