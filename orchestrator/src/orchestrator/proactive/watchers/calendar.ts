import Logger from '../../../logger';
import type {
    CalendarWatcherConfig,
    CandidateEvent,
    ProactiveDeps,
    Watcher,
} from '../types';

interface CalEvent {
    title?: string;
    date?: string; // YYYY-MM-DD
    start?: string; // HH:MM (événements horaires uniquement)
}

function flattenEvents(raw: unknown): CalEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as {
        events?: CalEvent[];
        days?: { events?: CalEvent[] }[];
    };
    if (Array.isArray(obj.events)) return obj.events;
    if (Array.isArray(obj.days)) {
        return obj.days.flatMap((d) => d.events ?? []);
    }
    return [];
}

export async function evaluateCalendar(
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>,
    cfg: CalendarWatcherConfig,
    now: Date,
): Promise<CandidateEvent[]> {
    const events = flattenEvents(await deviceHandler('get_today'));
    const out: CandidateEvent[] = [];
    for (const e of events) {
        if (!e.date || !e.start || !/^\d{2}:\d{2}$/.test(e.start)) continue;
        const startMs = new Date(`${e.date}T${e.start}:00`).getTime();
        const diffMin = (startMs - now.getTime()) / 60_000;
        if (diffMin > 0 && diffMin <= cfg.remindMinutesBefore) {
            out.push({
                watcherId: 'calendar',
                subject: `event-${e.date}-${e.start}`,
                importance: 'utile',
                facts: `Rendez-vous « ${e.title ?? 'sans titre'} » à ${
                    e.start
                }, dans ${Math.round(diffMin)} minutes.`,
            });
        }
    }
    return out;
}

export function createCalendarWatcher(
    cfg: CalendarWatcherConfig,
    deps: ProactiveDeps,
): Watcher {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = async (emit: (c: CandidateEvent) => void): Promise<void> => {
        try {
            const events = await evaluateCalendar(
                deps.deviceHandler,
                cfg,
                new Date(deps.now ? deps.now() : Date.now()),
            );
            Logger.info(
                `proactive[calendar]: poll → ${events.length} candidat(s)` +
                    (events.length
                        ? ` (${events.map((e) => e.subject).join(', ')})`
                        : ''),
            );
            for (const e of events) emit(e);
        } catch (err) {
            Logger.warn(`proactive[calendar]: ${err}`);
        }
    };
    return {
        id: 'calendar',
        start(emit) {
            void tick(emit);
            timer = setInterval(
                () => void tick(emit),
                cfg.pollMinutes * 60_000,
            );
        },
        stop() {
            if (timer) clearInterval(timer);
        },
    };
}
