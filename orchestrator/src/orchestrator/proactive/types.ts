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

export interface Watcher {
    id: string;
    start(emit: (c: CandidateEvent) => void): void;
    stop(): void;
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

export interface ProactiveConfig {
    enabled: boolean;
    chattiness: Chattiness;
    quietHours: { start: string; end: string };
    digestTime: string;
    defaultCooldownMin: number;
    automationGuardWindowMin: number;
    whitelist: WhitelistAction[];
    /** Editable system prompts for proactive message formulation. */
    prompts?: { phrase?: string; digest?: string };
    weather?: WeatherWatcherConfig;
    calendar?: CalendarWatcherConfig;
    mail?: MailWatcherConfig;
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
