import type { AgendaEvent } from '../../agendaSecretary';
import type { DayPlan } from '../../schedule/dayPlan';

export type ReminderType =
    | 'morning'
    | 'agenda-eve'
    | 'agenda-imminent'
    | 'depart'
    | 'parcel'
    | 'return';

export interface Reminder {
    key: string;
    type: ReminderType;
    notif: string;
    spoken: string;
    wantsSpeech: boolean;
    device?: string;
}

export interface ReminderSettings {
    eveTime: string; // HH:MM
    visioLeadMin: number;
    onsiteLeadMin: number;
    departLeadMin: number;
    morningFallback: string; // HH:MM
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
    eveTime: '21:00',
    visioLeadMin: 10,
    onsiteLeadMin: 45,
    departLeadMin: 15,
    morningFallback: '09:00',
};

export interface ParcelInfo {
    id: string;
    label: string;
    status: string;
    estimatedDate?: string;
    updatedAt: number;
}

export interface ReminderContext {
    now: Date;
    today: string;
    tomorrow: string;
    presence: 'home' | 'away' | 'unknown';
    quietHours: { start: string; end: string };
    plans: { today: DayPlan | null; tomorrow: DayPlan | null };
    events: AgendaEvent[];
    calendarOk: boolean;
    wake: { at: number; afterMin: number; device: string | null } | null;
    parcels: ParcelInfo[];
    /** Expéditeurs distincts des mails à traiter (ordre d'arrivée). */
    mails: string[];
    /** Nombre total de mails à traiter (≥ mails.length). */
    mailCount: number;
    postits: string[];
    notes: string[];
    weather: { notable: string | null } | null;
    lastDepartureAt: number | null;
    returnedAt: number | null;
    settings: ReminderSettings;
}
