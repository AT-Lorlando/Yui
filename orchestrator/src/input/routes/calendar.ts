import express from 'express';
import {
    eventMode,
    toAgendaEvent,
    type CallTool,
} from '../../orchestrator/agendaSecretary';
import { normalizeRule } from '../../orchestrator/calendarRules/model';
import { nextOccurrences } from '../../orchestrator/calendarRules/occurrences';
import {
    createRule,
    deleteRule,
    readRules,
    RulesFileError,
    updateRule,
} from '../../orchestrator/calendarRules/store';
import { getCalendarRulesSync } from '../../orchestrator/calendarRules/sync';
import { addDays, localYmd } from '../../orchestrator/schedule/dayPlan';
import type { ToolsHandler } from '../InputSource';
import type { RequireAuth } from './helpers';
import { toolsCallTool } from './schedule';

/** Fichier de règles illisible = erreur serveur ; sinon corps invalide. */
const writeStatus = (e: unknown) => (e instanceof RulesFileError ? 500 : 400);

const WEEK_CAL_RE = /num[ée]ros de semaine/i;

interface AgendaItem {
    id: string;
    title: string;
    date: string;
    endDate: string | null;
    start: string | null;
    end: string | null;
    allDay: boolean;
    calendar: string | null;
    calendarId: string | null;
    location: string | null;
    meetLink: string | null;
    mode: 'visio' | 'onsite' | 'unknown';
    ruleId: string | null;
}

async function buildAgenda(
    callTool: CallTool | null,
    today: string,
    days: number,
): Promise<{
    days: Array<{ date: string; events: AgendaItem[] }>;
    calendarOk: boolean;
}> {
    const dates = Array.from({ length: days }, (_, i) => addDays(today, i));
    const byDate = new Map<string, AgendaItem[]>(dates.map((d) => [d, []]));
    let calendarOk = true;
    try {
        if (!callTool) throw new Error('agenda indisponible');
        const res = (await callTool('get_schedule', {
            startDate: today,
            endDate: addDays(today, days - 1),
            maxResults: 250,
        })) as {
            days?: Array<Record<string, unknown>>;
            events?: unknown[];
        } | null;
        // Fenêtre vide : get_schedule rend {events: [], start, end} sans `days`.
        const emptyWindow =
            !!res &&
            !Array.isArray(res.days) &&
            Array.isArray(res.events) &&
            res.events.length === 0;
        if (!res || (!Array.isArray(res.days) && !emptyWindow))
            throw new Error('réponse invalide');
        for (const day of res.days ?? []) {
            const list = Array.isArray(day.events)
                ? (day.events as Array<Record<string, unknown>>)
                : [];
            for (const ev of list) {
                const e = toAgendaEvent(ev, String(day.date ?? ''));
                if (!e || (e.calendar && WEEK_CAL_RE.test(e.calendar)))
                    continue;
                const item: AgendaItem = {
                    id: e.id,
                    title: e.title,
                    date: e.date,
                    endDate: e.endDate,
                    start: e.start,
                    end: typeof ev.end === 'string' ? ev.end : null,
                    allDay: e.allDay,
                    calendar: e.calendar ?? null,
                    calendarId: e.calendarId ?? null,
                    location: e.location,
                    meetLink: e.meetLink ?? null,
                    mode: eventMode(e),
                    ruleId: e.ruleId ?? null,
                };
                const last =
                    e.endDate && e.endDate > e.date ? e.endDate : e.date;
                for (const d of dates) {
                    if (d < e.date || d > last) continue;
                    const b = byDate.get(d)!;
                    if (!b.some((x) => x.id === item.id)) b.push(item);
                }
            }
        }
    } catch {
        calendarOk = false;
        for (const d of dates) byDate.set(d, []);
    }
    const rank = (i: AgendaItem) => (i.allDay ? '' : i.start ?? '~');
    return {
        days: dates.map((date) => ({
            date,
            events: byDate
                .get(date)!
                .sort((a, b) => rank(a).localeCompare(rank(b))),
        })),
        calendarOk,
    };
}

export function calendarRoutes(
    requireAuth: RequireAuth,
    toolsHandler?: ToolsHandler,
): express.Router {
    const r = express.Router();
    const callTool = toolsHandler ? toolsCallTool(toolsHandler) : null;

    r.get('/calendar/rules', requireAuth, (_req: any, res: any) => {
        try {
            res.json({
                rules: readRules(),
                sync: getCalendarRulesSync()?.status() ?? null,
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.post('/calendar/rules/preview', requireAuth, (req: any, res: any) => {
        try {
            const today = localYmd(new Date());
            const rule = normalizeRule(req.body, { id: 'preview', today });
            res.json({ dates: nextOccurrences(rule, today, 6) });
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    });

    r.post('/calendar/rules/sync', requireAuth, async (_req: any, res: any) => {
        const sync = getCalendarRulesSync();
        if (!sync)
            return res
                .status(503)
                .json({ error: 'Synchronisation indisponible' });
        try {
            res.json(await sync.runOnce());
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.post('/calendar/rules', requireAuth, (req: any, res: any) => {
        try {
            const rule = createRule(req.body);
            getCalendarRulesSync()?.request();
            res.status(201).json({ rule });
        } catch (e: any) {
            res.status(writeStatus(e)).json({ error: e.message });
        }
    });

    r.put('/calendar/rules/:id', requireAuth, (req: any, res: any) => {
        try {
            const rule = updateRule(String(req.params.id), req.body);
            if (!rule)
                return res.status(404).json({ error: 'Règle introuvable' });
            getCalendarRulesSync()?.request();
            res.json({ rule });
        } catch (e: any) {
            res.status(writeStatus(e)).json({ error: e.message });
        }
    });

    r.delete('/calendar/rules/:id', requireAuth, (req: any, res: any) => {
        try {
            if (!deleteRule(String(req.params.id)))
                return res.status(404).json({ error: 'Règle introuvable' });
            getCalendarRulesSync()?.request();
            res.json({ ok: true });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    r.get('/calendar/agenda', requireAuth, async (req: any, res: any) => {
        const days = req.query.days === undefined ? 14 : Number(req.query.days);
        if (!Number.isInteger(days) || days < 1 || days > 31) {
            return res
                .status(400)
                .json({ error: 'days doit être entre 1 et 31' });
        }
        try {
            res.json(await buildAgenda(callTool, localYmd(new Date()), days));
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    return r;
}
