// Contrat de connecteur (spec §3). Un connecteur = un fichier dans
// ./connectors/, déclaratif : identité + réglages (= sa brique), un poll
// optionnel (`events`), un état courant optionnel (`snapshot`) et, pour les
// sources événementielles, `subscribe`. Il n'ordonnance rien lui-même :
// c'est le ConnectorRunner qui l'appelle.
import type { PresenceState } from '../presence';
import type { BrickSetting } from './bricks';
import type { Event, Fact } from './events';
import type { ConnectorState } from './connectorState';
import type { MailConcierge } from './mail/concierge';
import type { ProactiveConfig, ProactiveDeps } from './types';

export interface ConnectorContext {
    callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
    /** Réglages effectifs de la brique (défauts + écarts de proactive.json). */
    settings: Record<string, unknown>;
    state: ConnectorState;
    presence(): PresenceState;
    now(): number;
    log: { info(m: string): void; warn(m: string): void };
}

export interface ConnectorDef {
    id: string;
    name: string;
    description: string;
    defaultEnabled: boolean;
    settings?: BrickSetting[];
    /** Absent = jamais pollé (push-only ou événementiel). */
    pollMinutes?: number;
    events?(ctx: ConnectorContext): Promise<Event[]>;
    snapshot?(ctx: ConnectorContext): Promise<Fact[]>;
    subscribe?(ctx: ConnectorContext, emit: (e: Event) => void): () => void;
}

/** Services que certains connecteurs empruntent au moteur. */
export interface ConnectorServices {
    concierge: MailConcierge;
    complete: (system: string, user: string) => Promise<string>;
    subscribePresence: ProactiveDeps['subscribePresence'];
    /** Sections historiques de proactive.json (weather/calendar/mail/deliveries). */
    legacy: Pick<
        ProactiveConfig,
        'weather' | 'calendar' | 'mail' | 'deliveries'
    >;
}
