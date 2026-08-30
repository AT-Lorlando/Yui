import Logger from '../logger';

/**
 * Garde anti-faux-départ.
 *
 * Le geofence Android émet des EXIT fantômes quand le téléphone dort (fix
 * cell-tower imprécis en Doze) : audit du 30/08 — faux départ à 01h18 le
 * 17/08, scène « Good bye » déclenchée en pleine nuit, puis état bloqué
 * `away` deux jours, avalant le vrai départ suivant.
 *
 * Principe : un EXIT ne vaut plus confirmation. On attend un court délai puis
 * on vérifie plusieurs fois si le téléphone est visible sur le réseau local
 * (ARP/DHCP — l'infra de checkPhoneOnNetwork). Vu → veto, on reste home.
 * Jamais vu → départ confirmé. Un vrai départ n'est retardé que de ~1-2 min
 * (le temps que le wifi du téléphone décroche vraiment), un EXIT fantôme
 * nocturne est neutralisé à la première vérification.
 */
export interface DepartureGuardOpts {
    /** Attente avant la première vérification (le wifi met ~1 min à décrocher). */
    delayMs: number;
    /** Nombre de vérifications réseau. */
    checks: number;
    /** Intervalle entre vérifications. */
    intervalMs: number;
    /** true = téléphone vu sur le réseau ; null = routeur injoignable. */
    isPhoneHome: () => Promise<boolean | null>;
    /** Annulation externe (un ENTER est arrivé entre-temps). */
    isCancelled?: () => boolean;
    /** Injectable pour les tests. */
    sleep?: (ms: number) => Promise<void>;
}

export type DepartureVerdict = 'confirmed' | 'vetoed' | 'cancelled';

export async function confirmDeparture(
    opts: DepartureGuardOpts,
): Promise<DepartureVerdict> {
    const sleep =
        opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const cancelled = () => opts.isCancelled?.() === true;

    await sleep(opts.delayMs);
    if (cancelled()) return 'cancelled';

    for (let i = 0; i < opts.checks; i++) {
        if (i > 0) {
            await sleep(opts.intervalMs);
            if (cancelled()) return 'cancelled';
        }
        let present: boolean | null = null;
        try {
            present = await opts.isPhoneHome();
        } catch (e) {
            Logger.warn(`[presence] departure check failed: ${e}`);
        }
        if (cancelled()) return 'cancelled';
        if (present === true) return 'vetoed';
        // present === false → on continue à vérifier ; null (routeur muet) →
        // on ne peut rien conclure de cette vérification, on continue aussi.
    }
    // Jamais vu sur le réseau pendant toute la fenêtre → départ réel.
    return 'confirmed';
}
