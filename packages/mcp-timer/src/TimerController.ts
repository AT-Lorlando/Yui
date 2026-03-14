import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Logger from './logger';

const TIMERS_FILE = path.resolve(process.cwd(), 'data/timers.json');

export interface Timer {
    id: string;
    label: string;
    duration_seconds: number;
    started_at: number;   // ms
    fires_at: number;     // ms
    room?: string;
}

const _handles = new Map<string, NodeJS.Timeout>();

function ensureDataDir(): void {
    const dir = path.dirname(TIMERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTimers(): Timer[] {
    try {
        if (!fs.existsSync(TIMERS_FILE)) return [];
        return JSON.parse(fs.readFileSync(TIMERS_FILE, 'utf-8')) as Timer[];
    } catch {
        return [];
    }
}

function saveTimers(timers: Timer[]): void {
    ensureDataDir();
    fs.writeFileSync(TIMERS_FILE, JSON.stringify(timers, null, 2));
}

function removeTimerFromFile(id: string): void {
    const timers = loadTimers().filter((t) => t.id !== id);
    saveTimers(timers);
}

async function blinkRoom(roomName: string): Promise<void> {
    const ip = process.env.HUE_BRIDGE_IP;
    const user = process.env.HUE_USERNAME;
    if (!ip || !user) {
        Logger.warn('Hue env vars not set — skipping blink');
        return;
    }
    try {
        const resp = await fetch(`http://${ip}/api/${user}/groups`);
        const groups = (await resp.json()) as Record<string, { name: string }>;
        const groupId = Object.keys(groups).find((id) =>
            groups[id].name.toLowerCase().includes(roomName.toLowerCase()),
        );
        if (!groupId) {
            Logger.warn(`No Hue group found matching "${roomName}"`);
            return;
        }
        await fetch(`http://${ip}/api/${user}/groups/${groupId}/action`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alert: 'lselect' }),
        });
        Logger.info(`Blink triggered on group "${groups[groupId].name}" (${groupId})`);
    } catch (err) {
        Logger.error(`Hue blink failed: ${err}`);
    }
}

// Base URL where sonneries are served by the orchestrator (e.g. http://10.0.0.101:3000/sonneries)
const RINGTONE_BASE_URL = (process.env.RINGTONE_BASE_URL ?? 'http://localhost:3000/ringtones').replace(/\/$/, '');
// Local path to ringtones directory — used to pick a random file
const RINGTONE_DIR = path.resolve(process.cwd(), process.env.RINGTONE_DIR ?? 'assets/ringtones');
// Orchestrator chime endpoint — receives { url } and casts it
const CHIME_ENDPOINT = process.env.CHIME_ENDPOINT ?? 'http://localhost:3000/chime';

async function castRingtone(): Promise<void> {
    let files: string[] = [];
    try {
        files = fs.readdirSync(RINGTONE_DIR).filter((f) => /\.(mp3|wav|ogg|flac)$/i.test(f));
    } catch {
        Logger.warn(`Sonnerie directory not found: ${RINGTONE_DIR}`);
    }

    if (files.length === 0) {
        Logger.warn('No sonnerie files found — skipping audio alert');
        return;
    }

    const file = files[Math.floor(Math.random() * files.length)];
    const url  = `${RINGTONE_BASE_URL}/${encodeURIComponent(file)}`;
    Logger.info(`Casting sonnerie: ${file}`);

    try {
        await fetch(CHIME_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
            signal: AbortSignal.timeout(10_000),
        });
    } catch (err) {
        Logger.warn(`Chime cast failed: ${err}`);
    }
}

async function onFire(timer: Timer): Promise<void> {
    Logger.info(`Timer fired: "${timer.label}" (${timer.id})`);
    _handles.delete(timer.id);
    removeTimerFromFile(timer.id);

    // Run blink + sonnerie in parallel
    await Promise.allSettled([
        timer.room ? blinkRoom(timer.room) : Promise.resolve(),
        castRingtone(),
    ]);
}

function scheduleTimeout(timer: Timer): void {
    const remaining = timer.fires_at - Date.now();
    const delay = Math.max(remaining, 0);
    const handle = setTimeout(() => void onFire(timer), delay);
    _handles.set(timer.id, handle);
    Logger.info(
        `Timer scheduled: "${timer.label}" fires in ${Math.round(delay / 1000)}s`,
    );
}

export function initTimers(): void {
    const timers = loadTimers();
    for (const timer of timers) {
        if (timer.fires_at <= Date.now()) {
            Logger.info(`Timer "${timer.label}" expired during downtime — firing now`);
            void onFire(timer);
        } else {
            scheduleTimeout(timer);
        }
    }
    Logger.info(`Loaded ${timers.length} timer(s) from disk`);
}

export function setTimer(
    label: string,
    durationSeconds: number,
    room?: string,
): Timer {
    const now = Date.now();
    const timer: Timer = {
        id: crypto.randomUUID().slice(0, 8),
        label,
        duration_seconds: durationSeconds,
        started_at: now,
        fires_at: now + durationSeconds * 1_000,
        ...(room ? { room } : {}),
    };

    const timers = loadTimers();
    timers.push(timer);
    saveTimers(timers);
    scheduleTimeout(timer);
    return timer;
}

export function cancelTimer(id: string): boolean {
    const timers = loadTimers();
    const exists = timers.some((t) => t.id === id);
    if (!exists) return false;

    const handle = _handles.get(id);
    if (handle) {
        clearTimeout(handle);
        _handles.delete(id);
    }
    removeTimerFromFile(id);
    Logger.info(`Timer cancelled: ${id}`);
    return true;
}

export function listTimers(): { timer: Timer; remaining_seconds: number }[] {
    return loadTimers().map((timer) => ({
        timer,
        remaining_seconds: Math.max(
            0,
            Math.round((timer.fires_at - Date.now()) / 1_000),
        ),
    }));
}
