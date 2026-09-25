import type { PresenceState } from '../presence';

export type Importance = 'info' | 'utile' | 'urgent' | 'critique';
export type Chattiness = 'discret' | 'normal' | 'bavard';

export interface CandidateEvent {
    watcherId: string;
    /** Clé de dédoublonnage, ex. "temp-anomaly", "door-unlocked". */
    subject: string;
    importance: Importance;
    /** Contexte factuel pour la formulation — Yui n'invente rien. */
    facts: string;
    /** Message pré-écrit → court-circuite le LLM. */
    template?: string;
    /** Action whitelist optionnelle. */
    proposedAction?: { id: string; tag: string };
    /** Fenêtre anti-répétition propre (défaut global sinon). */
    cooldownMs?: number;
}

export type WhitelistAction = {
    id: string;
    tag: string;
    action:
        | { tool: string; args?: Record<string, unknown> }
        | { sceneId: string };
};

export interface WeatherWatcherConfig {
    pollMinutes: number;
    /** Température max typique par mois (index 0 = janvier). */
    monthlyNormalsC: number[];
    anomalyMarginC: number;
    hotThresholdC: number;
    rainThresholdMm: number;
}

export interface CalendarWatcherConfig {
    pollMinutes: number;
    remindMinutesBefore: number;
}

export interface MailWatcherConfig {
    pollMinutes: number;
    /** Requête Gmail native pour cibler l'important. */
    query: string;
}

export interface DeliveriesWatcherConfig {
    pollMinutes: number;
    /** Requête Gmail (défaut : expéditeurs de suivi usuels, newer_than:1d). */
    query?: string;
}

/** Écarts par brique — tout ce qui n'est pas listé garde son défaut. */
export type BrickOverrides = Record<
    string,
    { enabled?: boolean; settings?: Record<string, unknown> }
>;

export interface ConciergeRule {
    /** Sous-chaîne cherchée dans l'expéditeur (adresse ou domaine). */
    match: string;
    category: string;
}

export interface CustomCategory {
    id: string;
    label?: string;
    description?: string;
    archive?: boolean;
}

export interface ConciergeConfig {
    pollMinutes?: number;
    /** Catégories appliquées sans validation (labels + archivage promo/news). */
    autoCategories?: string[];
    /** Règles apprises des corrections — appliquées avant le LLM (0 token). */
    rules?: ConciergeRule[];
    /** Règles en français injectées dans le prompt (acceptées depuis les doutes). */
    promptRules?: string[];
    /** Catégories ajoutées par Jérémy (ou proposées par le LLM et acceptées). */
    customCategories?: CustomCategory[];
}

export interface ProactiveConfig {
    enabled: boolean;
    chattiness: Chattiness;
    quietHours: { start: string; end: string };
    digestTime: string;
    defaultCooldownMin: number;
    automationGuardWindowMin: number;
    /** Budget d'interruptions quotidien du juge (speak=1, notify=0.5). */
    budgetPerDay?: number;
    bricks?: BrickOverrides;
    concierge?: ConciergeConfig;
    whitelist: WhitelistAction[];
    /** Editable system prompts for proactive message formulation. */
    prompts?: { phrase?: string; digest?: string };
    weather?: WeatherWatcherConfig;
    calendar?: CalendarWatcherConfig;
    mail?: MailWatcherConfig;
    deliveries?: DeliveriesWatcherConfig;
}

export interface ProactiveDeps {
    complete: (system: string, user: string) => Promise<string>;
    notify: (text: string) => Promise<void>;
    speak: (text: string) => Promise<void>;
    presenceState: () => PresenceState;
    subscribePresence: (
        cb: (prev: PresenceState, next: PresenceState) => void,
    ) => void;
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>;
    runScene: (id: string) => Promise<{ success: boolean; error?: string }>;
    /** Horloge injectable pour les tests. */
    now?: () => number;
}
