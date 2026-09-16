// Moments de vie — les briefs ne partent plus à heure fixe mais s'accrochent
// aux TRANSITIONS observées : réveil (premières lumières du matin), départ
// imminent (event d'agenda avec lieu + encore à la maison), retour (geofence),
// coucher (extinction du soir). Chaque moment est une brique désactivable.
//
// La détection est une fonction PURE sur deux instantanés successifs de la
// situation + un état de « déjà déclenché » (un réveil par jour, un coucher
// par nuit, un départ par événement) — testable sans horloge réelle.
import type { Situation } from './situation';

export type MomentKind =
    | 'moment-wake'
    | 'moment-departure'
    | 'moment-return'
    | 'moment-bedtime';

export interface Moment {
    kind: MomentKind;
    /** Contexte factuel spécifique au déclenchement (le juge compose dessus). */
    facts: string;
}

export interface MomentState {
    /** toDateString() du dernier réveil déclenché. */
    wakeDay?: string;
    /** toDateString() du dernier coucher déclenché (jour du déclenchement). */
    bedDay?: string;
    /** Clés d'événements d'agenda déjà rappelés (titre+date+heure). */
    firedDepartures: string[];
}

export const DEPARTURE_WINDOW_MIN = { min: 10, max: 45 };

const dayOf = (ts: number) => new Date(ts).toDateString();
const hourOf = (ts: number) => new Date(ts).getHours();

/**
 * Détecte les moments entre deux instantanés. Retourne les moments déclenchés
 * et le nouvel état. `enabled` filtre par brique.
 */
export function detectMoments(
    prev: Situation | null,
    next: Situation,
    state: MomentState,
    enabled: (kind: MomentKind) => boolean,
): { moments: Moment[]; state: MomentState } {
    const out: Moment[] = [];
    const st: MomentState = {
        ...state,
        firedDepartures: [...state.firedDepartures],
    };
    const hour = hourOf(next.at);
    const today = dayOf(next.at);

    // ── Réveil : premières lumières du matin, présent, une fois par jour ──
    if (
        enabled('moment-wake') &&
        prev &&
        next.presence === 'home' &&
        hour >= 5 &&
        hour < 12 &&
        prev.lightsOn.length === 0 &&
        next.lightsOn.length > 0 &&
        st.wakeDay !== today
    ) {
        st.wakeDay = today;
        out.push({
            kind: 'moment-wake',
            facts:
                'Jérémy vient d’allumer ses premières lumières du matin — ' +
                'c’est le moment du point du réveil (agenda du jour, météo si notable, mails à traiter, colis attendus).',
        });
    }

    // ── Coucher : extinction du soir, présent, une fois par nuit ──────────
    if (
        enabled('moment-bedtime') &&
        prev &&
        next.presence === 'home' &&
        (hour >= 21 || hour < 3) &&
        prev.lightsOn.length > 0 &&
        next.lightsOn.length === 0 &&
        st.bedDay !== today
    ) {
        st.bedDay = today;
        const issues: string[] = [];
        if (next.doorLocked === false)
            issues.push('la porte n’est pas verrouillée');
        if (next.musicPlaying) issues.push('la musique tourne encore');
        out.push({
            kind: 'moment-bedtime',
            facts:
                'Toutes les lumières viennent de s’éteindre pour la nuit.' +
                (issues.length
                    ? ` Points à signaler : ${issues.join(' ; ')}.`
                    : ' Rien d’anormal — ne parler que si le lendemain commence tôt ou si quelque chose cloche.'),
        });
    }

    // ── Départ imminent : event avec lieu dans 10-45 min, encore là ──────
    if (enabled('moment-departure') && next.presence === 'home') {
        for (const ev of next.agenda) {
            if (!ev.location || !ev.start) continue;
            const startMs = new Date(`${ev.date}T${ev.start}:00`).getTime();
            const inMin = (startMs - next.at) / 60_000;
            if (
                inMin < DEPARTURE_WINDOW_MIN.min ||
                inMin > DEPARTURE_WINDOW_MIN.max
            )
                continue;
            const key = `${ev.title}|${ev.date}|${ev.start}`;
            if (st.firedDepartures.includes(key)) continue;
            st.firedDepartures.push(key);
            if (st.firedDepartures.length > 40) st.firedDepartures.shift();
            out.push({
                kind: 'moment-departure',
                facts:
                    `« ${ev.title} » commence à ${ev.start} à « ${ev.location} » ` +
                    `(dans ~${Math.round(
                        inMin,
                    )} min) et Jérémy est encore à la maison.`,
            });
        }
    }

    return { moments: out, state: st };
}

/**
 * Moment retour — déclenché par la transition de présence (pas par le tick).
 * Retourne les facts du moment, ou null si rien ne mérite d'être dit
 * (le juge tranchera de toute façon, mais on lui donne la matière).
 */
export function returnMomentFacts(situation: Situation | null): string {
    const bits: string[] = [];
    if (situation) {
        const delivered = situation.parcels.filter(
            (p) => p.status === 'delivered',
        );
        if (delivered.length) {
            bits.push(
                `colis livré pendant l’absence : ${delivered
                    .map((p) => p.label)
                    .join(', ')}`,
            );
        }
        if (situation.mailActions.length) {
            bits.push(
                `${situation.mailActions.length} mail(s) demandent une action`,
            );
        }
        const next = situation.agenda[0];
        if (next?.start)
            bits.push(`prochain événement : « ${next.title} » à ${next.start}`);
    }
    return (
        'Jérémy vient de rentrer à la maison.' +
        (bits.length
            ? ` Pendant l’absence / à venir : ${bits.join(' ; ')}.`
            : ' Rien de particulier à signaler — ne parler que si utile.')
    );
}
