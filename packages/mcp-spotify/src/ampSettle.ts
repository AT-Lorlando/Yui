// Délai de stabilisation de l'ampli (IR, pas de retour d'état) : un
// `power_toggle` envoyé pendant que le Marantz s'allume ou s'éteint encore
// est ignoré par l'appareil, et notre état persisté diverge du réel (vécu :
// ON puis OFF trop vite → état « off », ampli allumé). Pur, testé.

/** Défaut : ~5 s, le temps de cycle d'alimentation observé sur le SR4500. */
export const AMP_SETTLE_MS = Number(process.env.AMP_SETTLE_MS ?? 5000);

/** Millisecondes à attendre avant d'envoyer le prochain toggle. */
export function settleDelay(
    lastToggleAt: number,
    now: number,
    settleMs = AMP_SETTLE_MS,
): number {
    if (!lastToggleAt) return 0;
    return Math.max(0, lastToggleAt + settleMs - now);
}
