/**
 * Exécution de `set_lights_bulk` : les entrées Hue partent EN PARALLÈLE (une
 * scène de 7 entrées s'allumait lampe par lampe quand chacune attendait la
 * précédente), les entrées Govee ensuite, une par une (UDP, rampe de couleur
 * logicielle — cf. goveeFade). Une lampe en échec n'empêche jamais les
 * autres : son erreur rejoint le texte rendu.
 */

import type { BulkEntry } from './bulkStates';

/** Transition par défaut d'une entrée bulk : les lampes montent ensemble. */
export const BULK_DEFAULT_TRANSITION_MS = 400;

export async function runBulkEntries(
    entries: BulkEntry[],
    isGoveeEntry: (e: BulkEntry) => boolean,
    apply: (e: BulkEntry) => Promise<string>,
): Promise<string[]> {
    const results: string[] = new Array(entries.length);
    const fail = (e: BulkEntry, err: unknown) =>
        `${e.target} : échec (${
            err instanceof Error ? err.message : String(err)
        })`;

    // 1. Le lot Hue est lancé d'un coup…
    const hue = entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !isGoveeEntry(e));
    const hueBatch = Promise.allSettled(
        hue.map(({ e }) => {
            try {
                return apply(e); // démarré tout de suite, pas au tick suivant
            } catch (err) {
                return Promise.reject(err);
            }
        }),
    );

    // 2. …puis les Govee, en séquence, pendant que les Hue fondent.
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!isGoveeEntry(e)) continue;
        try {
            results[i] = await apply(e);
        } catch (err) {
            results[i] = fail(e, err);
        }
    }

    const settled = await hueBatch;
    settled.forEach((r, k) => {
        const { e, i } = hue[k];
        results[i] = r.status === 'fulfilled' ? r.value : fail(e, r.reason);
    });
    return results;
}
