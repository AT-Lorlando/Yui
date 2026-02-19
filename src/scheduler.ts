import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import cron from 'node-cron';
import Logger from './logger';

const SCHEDULES_FILE = path.resolve(process.cwd(), 'data/schedules.json');

export interface Schedule {
    id: string;
    name: string;
    cron: string;
    prompt: string;
    enabled: boolean;
}

type OrderFn = (prompt: string) => Promise<string>;
type SpeakFn = (text: string) => Promise<void>;

const _tasks = new Map<string, ReturnType<typeof cron.schedule>>();
let _onOrder: OrderFn | null = null;
let _onSpeak: SpeakFn | null = null;

function ensureDataDir(): void {
    const dir = path.dirname(SCHEDULES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadSchedules(): Schedule[] {
    try {
        if (!fs.existsSync(SCHEDULES_FILE)) return [];
        return JSON.parse(
            fs.readFileSync(SCHEDULES_FILE, 'utf-8'),
        ) as Schedule[];
    } catch {
        return [];
    }
}

function saveSchedules(schedules: Schedule[]): void {
    ensureDataDir();
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
}

function startTask(schedule: Schedule): void {
    if (!cron.validate(schedule.cron)) {
        Logger.warn(
            `Invalid cron expression for "${schedule.name}": ${schedule.cron}`,
        );
        return;
    }

    const task = cron.schedule(
        schedule.cron,
        async () => {
            Logger.info(
                `Cron trigger: "${schedule.name}" — "${schedule.prompt}"`,
            );
            if (!_onOrder) return;
            try {
                const response = await _onOrder(schedule.prompt);
                if (_onSpeak && response) await _onSpeak(response);
            } catch (err) {
                Logger.error(`Cron task "${schedule.name}" failed: ${err}`);
            }
        },
        { timezone: 'Europe/Paris' },
    );

    _tasks.set(schedule.id, task);
}

/**
 * Initialize the scheduler. Must be called once on startup.
 * @param onOrder  Called with the schedule's prompt — returns Yui's response text
 * @param onSpeak  Called with the response text to speak it (e.g. POST to voice pipeline)
 */
export function initScheduler(onOrder: OrderFn, onSpeak: SpeakFn): void {
    _onOrder = onOrder;
    _onSpeak = onSpeak;

    const schedules = loadSchedules();
    for (const s of schedules) {
        if (s.enabled) startTask(s);
    }

    const active = schedules.filter((s) => s.enabled).length;
    Logger.info(`Scheduler: ${active} active schedule(s) loaded`);
}

export function addSchedule(
    name: string,
    cronExpr: string,
    prompt: string,
): Schedule | string {
    if (!cron.validate(cronExpr)) {
        return `Expression cron invalide : "${cronExpr}"`;
    }

    const schedule: Schedule = {
        id: crypto.randomUUID().slice(0, 8),
        name,
        cron: cronExpr,
        prompt,
        enabled: true,
    };

    const schedules = loadSchedules();
    schedules.push(schedule);
    saveSchedules(schedules);

    if (_onOrder) startTask(schedule);

    Logger.info(`Schedule added: "${name}" (${cronExpr}) → "${prompt}"`);
    return schedule;
}

export function deleteSchedule(id: string): boolean {
    const schedules = loadSchedules();
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx < 0) return false;

    schedules.splice(idx, 1);
    saveSchedules(schedules);

    const task = _tasks.get(id);
    if (task) {
        task.stop();
        _tasks.delete(id);
    }

    return true;
}

export function toggleSchedule(id: string): string {
    const schedules = loadSchedules();
    const schedule = schedules.find((s) => s.id === id);
    if (!schedule) return `Schedule "${id}" introuvable.`;

    schedule.enabled = !schedule.enabled;
    saveSchedules(schedules);

    if (schedule.enabled) {
        if (_onOrder) startTask(schedule);
    } else {
        const task = _tasks.get(id);
        if (task) {
            task.stop();
            _tasks.delete(id);
        }
    }

    return `Schedule "${schedule.name}" ${
        schedule.enabled ? 'activé' : 'désactivé'
    }.`;
}

export function listSchedules(): string {
    const schedules = loadSchedules();
    if (schedules.length === 0) return '(aucun schedule enregistré)';
    return schedules
        .map(
            (s) =>
                `[${s.id}] "${s.name}" — ${s.cron} — ${
                    s.enabled ? '✓ actif' : '✗ désactivé'
                }\n  → "${s.prompt}"`,
        )
        .join('\n');
}
