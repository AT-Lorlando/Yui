// Persistance de l'emploi du temps : data/config/schedule.json.
// Absent → semaine type par défaut (non écrite). Les exceptions passées sont
// purgées à la lecture.

import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import {
    DEFAULT_SCHEDULE,
    localYmd,
    normalizeException,
    normalizeTemplate,
    type DayTemplate,
    type Schedule,
    type ScheduleException,
} from './dayPlan';

const WEEK_KEYS = ['0', '1', '2', '3', '4', '5', '6'];

function file(): string {
    return dataPath('schedule.json');
}

function cloneDefault(): Schedule {
    return {
        week: Object.fromEntries(
            WEEK_KEYS.map((k) => [k, { ...DEFAULT_SCHEDULE.week[k] }]),
        ),
        exceptions: [],
    };
}

function write(s: Schedule): void {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, f);
}

function parse(raw: unknown): Schedule {
    const out = cloneDefault();
    const r = (raw ?? {}) as Record<string, unknown>;
    const week = (r.week ?? {}) as Record<string, unknown>;
    for (const k of WEEK_KEYS) {
        if (week[k] === undefined) continue;
        try {
            out.week[k] = normalizeTemplate(week[k]);
        } catch (e) {
            Logger.warn(
                `[schedule] jour ${k} ignoré : ${(e as Error).message}`,
            );
        }
    }
    for (const e of Array.isArray(r.exceptions) ? r.exceptions : []) {
        try {
            out.exceptions.push(normalizeException(e));
        } catch (err) {
            Logger.warn(
                `[schedule] exception ignorée : ${(err as Error).message}`,
            );
        }
    }
    out.exceptions.sort((a, b) => a.date.localeCompare(b.date));
    return out;
}

export function readSchedule(today: string = localYmd(new Date())): Schedule {
    const f = file();
    if (!fs.existsSync(f)) return cloneDefault();
    let s: Schedule;
    try {
        s = parse(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch (e) {
        Logger.warn(
            `[schedule] ${f} illisible, semaine par défaut : ${
                (e as Error).message
            }`,
        );
        return cloneDefault();
    }
    const kept = s.exceptions.filter((e) => e.date >= today);
    if (kept.length !== s.exceptions.length) {
        s.exceptions = kept;
        // Purge best-effort : une lecture ne doit jamais échouer sur le disque.
        try {
            write(s);
        } catch (e) {
            Logger.warn(
                `[schedule] purge non écrite : ${(e as Error).message}`,
            );
        }
    }
    return s;
}

export function setWeek(week: Record<string, unknown>): Schedule {
    if (!week || typeof week !== 'object') throw new Error('Semaine invalide');
    const next: Record<string, DayTemplate> = {};
    for (const k of WEEK_KEYS) {
        if (week[k] === undefined) throw new Error(`Jour ${k} manquant`);
        next[k] = normalizeTemplate(week[k]);
    }
    const s = readSchedule();
    s.week = next;
    write(s);
    return s;
}

export function upsertException(
    e: unknown,
    today: string = localYmd(new Date()),
): Schedule {
    const exc: ScheduleException = normalizeException(e);
    if (exc.date < today) throw new Error('Date passée');
    const s = readSchedule(today);
    s.exceptions = s.exceptions.filter((x) => x.date !== exc.date);
    s.exceptions.push(exc);
    s.exceptions.sort((a, b) => a.date.localeCompare(b.date));
    write(s);
    return s;
}

export function removeException(date: string): Schedule | null {
    const s = readSchedule();
    const kept = s.exceptions.filter((x) => x.date !== date);
    if (kept.length === s.exceptions.length) return null;
    s.exceptions = kept;
    write(s);
    return s;
}
