import { evaluateCalendar } from '../watchers/calendar';
import { fetchAgendaEvents } from '../../agendaSecretary';
import { fromCandidate } from '../events';
import type { Event, Fact } from '../events';
import type { ConnectorDef } from '../connector';

export const calendarConnector: ConnectorDef = {
    id: 'calendar',
    name: 'Agenda',
    description:
        'Rappels avant les événements du calendrier ; agenda des 24 h dans la situation.',
    defaultEnabled: true,
    pollMinutes: 5,
    settings: [
        {
            key: 'pollMinutes',
            label: 'Intervalle (min)',
            type: 'number',
            default: 5,
        },
        {
            key: 'remindMinutesBefore',
            label: 'Rappel (min avant)',
            type: 'number',
            default: 30,
        },
        {
            key: 'maxPerHour',
            label: 'Max événements / heure',
            type: 'number',
            default: 6,
        },
    ],
    async events(ctx): Promise<Event[]> {
        const now = ctx.now();
        const cfg = {
            pollMinutes: Number(ctx.settings.pollMinutes ?? 5),
            remindMinutesBefore: Number(ctx.settings.remindMinutesBefore ?? 30),
        };
        return (await evaluateCalendar(ctx.callTool, cfg, new Date(now))).map(
            (c) => ({
                ...fromCandidate(c, now),
                // Un rappel n'a plus de sens une fois l'événement commencé.
                ttlMs: cfg.remindMinutesBefore * 60_000,
            }),
        );
    },
    /** Agenda 24 h brut — aucune annotation LLM (spec §6). */
    async snapshot(ctx): Promise<Fact[]> {
        const now = ctx.now();
        const events = await fetchAgendaEvents(ctx.callTool, new Date(now));
        return events
            .filter((ev) => {
                const start = new Date(
                    `${ev.date}T${ev.start ?? '00:00'}:00`,
                ).getTime();
                return start >= now - 3600_000 && start <= now + 24 * 3600_000;
            })
            .slice(0, 10)
            .map((ev) => ({
                label: 'Agenda',
                value: `${ev.title}${ev.start ? ` à ${ev.start}` : ''}${
                    ev.location ? ` (${ev.location})` : ''
                }`,
            }));
    },
};
