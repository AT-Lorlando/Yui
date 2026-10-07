import { execFile } from 'child_process';
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
 *
 * Ce que « vu sur le réseau » veut dire PENDANT la garde (fix du 07/10,
 * YUI-79) : le bail DHCP est statique et renouvelé toutes les 15 min, donc un
 * `last-seen` < 15 min ne prouve rien à exit + 60 s — c'est ce qui a mis au
 * veto tous les vrais départs du 19/09 au 07/10. Ne comptent plus que :
 *   - un bail DHCP vu APRÈS l'exit (fraîcheur = `now - exitAt`) ;
 *   - un ARP `reachable` juste après un ping actif (`pingHost`) — un
 *     téléphone endormi mais associé au wifi répond au ping, ce qui garde la
 *     protection du 17/08 ; un téléphone parti ne répond pas.
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

// ── Sonde active ──────────────────────────────────────────────────────────────

type ExecLike = (
    cmd: string,
    args: string[],
    opts: { timeout: number },
    cb: (error: Error | null) => void,
) => unknown;

export interface PingOpts {
    /** Délai d'attente de la réponse, en secondes (`ping -W`). */
    timeoutS?: number;
    /** Injectable pour les tests (jamais de réseau en test). */
    exec?: ExecLike;
}

/**
 * Ping unitaire, best-effort : true si l'hôte répond, false sinon — binaire
 * absent, délai dépassé, IP vide, exception : toujours false, ne throw JAMAIS
 * (la garde ne doit pas dépendre de la présence de `ping` sur la machine).
 *
 * Pourquoi un ping avant de lire l'ARP : un téléphone en veille laisse son
 * entrée ARP passer `stale`/`failed` sans avoir quitté le wifi ; l'ICMP le
 * réveille et le bridge repasse l'entrée en `reachable`. On distingue ainsi
 * « endormi à la maison » de « parti » sans faire confiance au bail DHCP.
 */
export function pingHost(ip: string, opts: PingOpts = {}): Promise<boolean> {
    const timeoutS = Math.max(1, Math.round(opts.timeoutS ?? 1));
    const exec: ExecLike = opts.exec ?? (execFile as unknown as ExecLike);
    if (!ip) return Promise.resolve(false);
    return new Promise((resolve) => {
        try {
            exec(
                'ping',
                ['-c', '1', '-W', String(timeoutS), ip],
                { timeout: (timeoutS + 2) * 1_000 },
                (error) => resolve(!error),
            );
        } catch (e) {
            Logger.debug(`[presence] ping ${ip} impossible: ${e}`);
            resolve(false);
        }
    });
}
