// Briques de proactivité — chaque capacité (watcher, moment, anticipation,
// module) est une brique déclarée ici, activable/désactivable depuis l'app
// (page /proactive) sans toucher au code. La config ne stocke que les écarts :
// `proactive.json → bricks: { <id>: { enabled, settings } }`.
//
// Exemple fondateur : « cohérence arrosage/pluie » n'a pas de sens quand les
// plantes sont sous un toit — c'est un toggle, pas un fork du code.
import type { ProactiveConfig } from './types';

export type BrickKind = 'watcher' | 'moment' | 'anticipation' | 'module';

export interface BrickSetting {
    key: string;
    label: string;
    type: 'boolean' | 'number' | 'string';
    default: unknown;
}

export interface BrickDef {
    id: string;
    name: string;
    description: string;
    kind: BrickKind;
    defaultEnabled: boolean;
    settings?: BrickSetting[];
}

export const BRICKS: BrickDef[] = [
    // ── Watchers (sources d'événements) ──────────────────────────────────
    {
        id: 'weather',
        name: 'Météo',
        description:
            'Anomalies météo (canicule, pluie forte, écart aux normales).',
        kind: 'watcher',
        defaultEnabled: true,
    },
    {
        id: 'presence',
        name: 'Présence',
        description:
            'Événements liés aux départs/arrivées (porte, lumières oubliées).',
        kind: 'watcher',
        defaultEnabled: true,
    },
    {
        id: 'calendar',
        name: 'Agenda',
        description: 'Rappels avant les événements du calendrier.',
        kind: 'watcher',
        defaultEnabled: true,
    },
    {
        id: 'mail-important',
        name: 'Mails importants',
        description: 'Signale les mails marqués importants par Gmail.',
        kind: 'watcher',
        defaultEnabled: true,
    },
    {
        id: 'deliveries',
        name: 'Livraisons',
        description:
            'Suivi de colis (transporteurs + contenu) et notifications de statut.',
        kind: 'watcher',
        defaultEnabled: true,
    },

    // ── Moments (briefs accrochés aux transitions de vie) ────────────────
    {
        id: 'moment-wake',
        name: 'Brief du réveil',
        description:
            'Un point du matin quand tu émerges vraiment (première lumière), pas à heure fixe : agenda, météo si notable, mails à traiter, colis attendus.',
        kind: 'moment',
        defaultEnabled: true,
    },
    {
        id: 'moment-departure',
        name: 'Départ imminent',
        description:
            "Un événement d'agenda avec lieu approche et tu es encore à la maison → rappel au bon moment (météo/parapluie compris).",
        kind: 'moment',
        defaultEnabled: true,
    },
    {
        id: 'moment-return',
        name: 'Retour à la maison',
        description:
            "À l'arrivée : ce qui s'est passé en ton absence (colis livré, mails à traiter) — seulement s'il y a quelque chose.",
        kind: 'moment',
        defaultEnabled: true,
    },
    {
        id: 'moment-bedtime',
        name: 'Vérifications du coucher',
        description:
            'Extinction du soir : porte non verrouillée, appareil resté allumé, rappel du lendemain matin si tôt.',
        kind: 'moment',
        defaultEnabled: true,
    },

    // ── Anticipations (règles fines) ─────────────────────────────────────
    {
        id: 'irrigation-rain',
        name: 'Cohérence arrosage/pluie',
        description:
            "Signale un arrosage programmé alors que la pluie est annoncée. À désactiver si les plantes sont abritées (sous un toit, l'arrosage reste utile).",
        kind: 'anticipation',
        defaultEnabled: false,
    },
    {
        id: 'anomaly-night',
        name: 'Anomalies nocturnes',
        description:
            'Pendant les heures de silence : porte déverrouillée, lumières restées allumées alors que tout dort.',
        kind: 'anticipation',
        defaultEnabled: true,
    },

    // ── Modules (gros morceaux) ──────────────────────────────────────────
    {
        id: 'judge',
        name: 'Juge à budget',
        description:
            "Le LLM arbitre chaque intervention (utilité × urgence) sous un budget d'interruptions quotidien, en tenant compte de tes 👍/👎. Désactivé : retour au pipeline simple (seuil de bavardage).",
        kind: 'module',
        defaultEnabled: true,
    },
    {
        id: 'mail-concierge',
        name: 'Concierge courrier',
        description:
            'Trie la boîte Gmail en continu (labels Yui/…) : action requise, à lire, admin, commandes, newsletters, promo. Mode propositions tant que tu corriges.',
        kind: 'module',
        defaultEnabled: false,
    },
    {
        id: 'briefing',
        name: 'Briefing (dashboard)',
        description:
            'Tuile compte-rendu : mails qui demandent une action, préparation des réunions à venir.',
        kind: 'module',
        defaultEnabled: true,
    },
];

const byId = new Map(BRICKS.map((b) => [b.id, b]));

export function brickDef(id: string): BrickDef | undefined {
    return byId.get(id);
}

/** Une brique inconnue de la config garde son défaut ; `enabled` explicite gagne. */
export function isBrickEnabled(
    cfg: Pick<ProactiveConfig, 'bricks'>,
    id: string,
): boolean {
    const def = byId.get(id);
    const override = cfg.bricks?.[id]?.enabled;
    if (override !== undefined) return override;
    return def?.defaultEnabled ?? false;
}

export function brickSetting<T>(
    cfg: Pick<ProactiveConfig, 'bricks'>,
    id: string,
    key: string,
    fallback: T,
): T {
    const v = cfg.bricks?.[id]?.settings?.[key];
    return (v === undefined ? fallback : v) as T;
}

/** Vue complète pour l'app : défs + état effectif (`values` = réglages posés). */
export function bricksView(
    cfg: Pick<ProactiveConfig, 'bricks'>,
): Array<BrickDef & { enabled: boolean; values: Record<string, unknown> }> {
    return BRICKS.map((b) => ({
        ...b,
        enabled: isBrickEnabled(cfg, b.id),
        values: cfg.bricks?.[b.id]?.settings ?? {},
    }));
}
