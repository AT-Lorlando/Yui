// Briques de proactivité — chaque capacité (watcher, moment, anticipation,
// module) est une brique activable/désactivable depuis l'app (page /proactive)
// sans toucher au code. La config ne stocke que les écarts :
// `proactive.json → bricks: { <id>: { enabled, settings } }`.
//
// Exemple fondateur : « cohérence arrosage/pluie » n'a pas de sens quand les
// plantes sont sous un toit — c'est un toggle, pas un fork du code.
//
// Les briques `watcher` ne sont PLUS déclarées ici : chaque connecteur
// (./connectors/*) porte la sienne (identité + réglages) et le moteur les
// enregistre au démarrage via `registerConnectorBricks`. `CORE_BRICKS` ne garde
// que ce qui n'a pas de source : moments, anticipations, modules.
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

export const CORE_BRICKS: BrickDef[] = [
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
        id: 'briefing',
        name: 'Briefing (dashboard)',
        description:
            'Tuile compte-rendu : mails qui demandent une action, préparation des réunions à venir.',
        kind: 'module',
        defaultEnabled: true,
    },
];

let connectorBricks: BrickDef[] = [];

/** Les connecteurs déclarent leur brique ; le moteur les enregistre au démarrage. */
export function registerConnectorBricks(
    defs: Array<
        Pick<
            BrickDef,
            'id' | 'name' | 'description' | 'defaultEnabled' | 'settings'
        >
    >,
): void {
    connectorBricks = defs.map((d) => ({ ...d, kind: 'watcher' as const }));
}

/** Connecteurs enregistrés d'abord (les sources), puis le reste. */
export function allBricks(): BrickDef[] {
    return [...connectorBricks, ...CORE_BRICKS];
}

// La liste dépend des connecteurs enregistrés au runtime : résolue à chaque
// appel, jamais figée au chargement du module.
export function brickDef(
    id: string,
    list: BrickDef[] = allBricks(),
): BrickDef | undefined {
    return list.find((b) => b.id === id);
}

/** Une brique inconnue de la config garde son défaut ; `enabled` explicite gagne. */
export function isBrickEnabled(
    cfg: Pick<ProactiveConfig, 'bricks'>,
    id: string,
    list: BrickDef[] = allBricks(),
): boolean {
    const override = cfg.bricks?.[id]?.enabled;
    if (override !== undefined) return override;
    const def = brickDef(id, list);
    if (def) return def.defaultEnabled;
    // Source externe (`external:<app>`) : aucune brique déclarée ici, elle
    // s'annonce en émettant. Active tant qu'un `enabled: false` explicite ne
    // la coupe pas.
    return id.startsWith('external:');
}

export function brickSetting<T>(
    cfg: Pick<ProactiveConfig, 'bricks'>,
    id: string,
    key: string,
    fallback: T,
    list: BrickDef[] = allBricks(),
): T {
    const v = cfg.bricks?.[id]?.settings?.[key];
    if (v !== undefined) return v as T;
    // Le défaut déclaré par la brique précède le fallback de l'appelant : une
    // source qui annonce `maxPerHour: 12` n'est pas ramenée à 6 par l'ingest.
    const declared = brickDef(id, list)?.settings?.find(
        (s) => s.key === key,
    )?.default;
    return (declared === undefined ? fallback : declared) as T;
}

/** Vue complète pour l'app : défs + état effectif (`values` = réglages posés). */
export function bricksView(
    cfg: Pick<ProactiveConfig, 'bricks'>,
    list: BrickDef[] = allBricks(),
): Array<BrickDef & { enabled: boolean; values: Record<string, unknown> }> {
    return list.map((b) => ({
        ...b,
        enabled: isBrickEnabled(cfg, b.id, list),
        values: cfg.bricks?.[b.id]?.settings ?? {},
    }));
}
