import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import { DEFAULT_WAKEUPS, normalizeWakeups, type Wakeup } from './model';

export interface PhoneAlarm {
    nextAt: number | null;
    reportedAt: number;
    source: string;
}

function atomicWrite(f: string, data: unknown): void {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, f);
}

function cloneDefault(): Wakeup[] {
    return JSON.parse(JSON.stringify(DEFAULT_WAKEUPS));
}

export function readWakeups(): Wakeup[] {
    const f = dataPath('wakeups.json');
    if (!fs.existsSync(f)) return cloneDefault();
    try {
        return normalizeWakeups(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch (e) {
        Logger.warn(
            `[wakeups] ${f} illisible, défaut : ${(e as Error).message}`,
        );
        return cloneDefault();
    }
}

export function writeWakeups(list: unknown): Wakeup[] {
    const out = normalizeWakeups(list);
    atomicWrite(dataPath('wakeups.json'), out);
    return out;
}

export function readPhoneAlarm(): PhoneAlarm | null {
    const f = dataPath('phone-alarm.json');
    if (!fs.existsSync(f)) return null;
    try {
        const r = JSON.parse(fs.readFileSync(f, 'utf8'));
        const nextAt =
            r.nextAt === null
                ? null
                : Number.isFinite(r.nextAt)
                ? (r.nextAt as number)
                : undefined;
        if (nextAt === undefined || !Number.isFinite(r.reportedAt)) return null;
        return {
            nextAt,
            reportedAt: r.reportedAt,
            source: typeof r.source === 'string' ? r.source : 'phone',
        };
    } catch (e) {
        Logger.warn(`[wakeups] ${f} illisible : ${(e as Error).message}`);
        return null;
    }
}

export function writePhoneAlarm(
    nextAt: unknown,
    source = 'phone',
    now: number = Date.now(),
): PhoneAlarm {
    if (
        nextAt !== null &&
        !(typeof nextAt === 'number' && Number.isFinite(nextAt))
    )
        throw new Error('nextAt : nombre ou null attendu');
    const a: PhoneAlarm = {
        nextAt: nextAt as number | null,
        reportedAt: now,
        source,
    };
    atomicWrite(dataPath('phone-alarm.json'), a);
    return a;
}
