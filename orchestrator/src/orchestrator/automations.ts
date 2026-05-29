import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import cron from 'node-cron';
import Logger from '../logger';
import { appendToHistory } from './history';

// ── Types ──────────────────────────────────────────────────────────────────────

export type OutputChannel = 'cast' | 'notify' | 'none';

export type AutomationTrigger =
    | { type: 'cron'; expr: string }
    | { type: 'delay'; ms: number; fireAt: number };

export type AutomationAction =
    | { type: 'scene'; sceneId: string }
    | { type: 'prompt'; text: string; output?: OutputChannel };

export interface Automation {
    id: string;
    name: string;
    trigger: AutomationTrigger;
    action: AutomationAction;
    /** TTS message spoken after execution. Ignored for prompt actions (LLM response is the output). */
    notify?: string | null;
    enabled: boolean;
    createdAt: number;
    /** Domaine touché par l'automation (ex. "irrigation"), lu par la garde proactive. */
    tag?: string;
}

export type CreateAutomationInput = Omit<Automation, 'id' | 'createdAt'>;

// ── Storage ────────────────────────────────────────────────────────────────────

const AUTOMATIONS_FILE = path.resolve(process.cwd(), 'data/automations.json');
const SCHEDULES_FILE = path.resolve(process.cwd(), 'data/schedules.json');

function ensureDataDir(): void {
    const dir = path.dirname(AUTOMATIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Migration ──────────────────────────────────────────────────────────────────

interface LegacySchedule {
    id: string;
    name: string;
    cron: string;
    prompt: string;
    enabled: boolean;
    output?: OutputChannel;
    oneshot?: boolean;
    createdAt?: number;
}

function migrateIfNeeded(): void {
    if (fs.existsSync(AUTOMATIONS_FILE)) return;
    if (!fs.existsSync(SCHEDULES_FILE)) return;
    try {
        const raw = JSON.parse(
            fs.readFileSync(SCHEDULES_FILE, 'utf-8'),
        ) as LegacySchedule[];
        // Oneshot schedules should have already fired — skip them
        const automations: Automation[] = raw
            .filter((s) => !s.oneshot)
            .map((s) => ({
                id: s.id,
                name: s.name,
                trigger: { type: 'cron' as const, expr: s.cron },
                action: {
                    type: 'prompt' as const,
                    text: s.prompt,
                    ...(s.output ? { output: s.output } : {}),
                },
                notify: null,
                enabled: s.enabled,
                createdAt: s.createdAt ?? Date.now(),
            }));
        ensureDataDir();
        fs.writeFileSync(
            AUTOMATIONS_FILE,
            JSON.stringify(automations, null, 2),
        );
        Logger.info(
            `Migrated ${automations.length} schedule(s) → automations.json`,
        );
    } catch (err) {
        Logger.warn(`Migration from schedules.json failed: ${err}`);
    }
}

// ── Read / write ───────────────────────────────────────────────────────────────

export function loadAutomations(): Automation[] {
    migrateIfNeeded();
    try {
        if (!fs.existsSync(AUTOMATIONS_FILE)) return [];
        return JSON.parse(
            fs.readFileSync(AUTOMATIONS_FILE, 'utf-8'),
        ) as Automation[];
    } catch {
        return [];
    }
}

function saveAutomations(automations: Automation[]): void {
    ensureDataDir();
    fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(automations, null, 2));
}

// ── CRUD ───────────────────────────────────────────────────────────────────────

export function addAutomation(input: CreateAutomationInput): Automation {
    const automation: Automation = {
        ...input,
        id: crypto.randomUUID().slice(0, 8),
        createdAt: Date.now(),
    };
    const automations = loadAutomations();
    automations.push(automation);
    saveAutomations(automations);
    Logger.info(`Automation added: "${automation.name}" (${automation.id})`);
    if (automation.enabled) scheduleAutomation(automation);
    return automation;
}

export function deleteAutomation(id: string): boolean {
    const automations = loadAutomations();
    const idx = automations.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    automations.splice(idx, 1);
    saveAutomations(automations);
    cancelAutomation(id);
    return true;
}

export function toggleAutomation(id: string): string | null {
    const automations = loadAutomations();
    const automation = automations.find((a) => a.id === id);
    if (!automation) return null;
    automation.enabled = !automation.enabled;
    saveAutomations(automations);
    if (automation.enabled) scheduleAutomation(automation);
    else cancelAutomation(id);
    return `Automation "${automation.name}" ${
        automation.enabled ? 'activée' : 'désactivée'
    }.`;
}

export function updateAutomation(
    id: string,
    patch: Partial<Omit<Automation, 'id' | 'createdAt'>>,
): Automation | null {
    const automations = loadAutomations();
    const automation = automations.find((a) => a.id === id);
    if (!automation) return null;
    cancelAutomation(id);
    Object.assign(automation, patch);
    saveAutomations(automations);
    if (automation.enabled) scheduleAutomation(automation);
    return automation;
}

/** Trigger an automation manually, regardless of its enabled state. */
export async function runAutomation(
    id: string,
): Promise<{ success: boolean; error?: string }> {
    const automation = loadAutomations().find((a) => a.id === id);
    if (!automation)
        return { success: false, error: `Automation "${id}" not found` };
    await execute(automation);
    return { success: true };
}

// ── Runtime ────────────────────────────────────────────────────────────────────

type OrderFn = (prompt: string) => Promise<string>;
type OutputFn = (text: string, channel: OutputChannel) => Promise<void>;
type RunSceneFn = (id: string) => Promise<{ success: boolean; error?: string }>;
type SpeakFn = (text: string) => Promise<void>;

const _cronTasks = new Map<string, ReturnType<typeof cron.schedule>>();
const _timeouts = new Map<string, ReturnType<typeof setTimeout>>();

let _onOrder: OrderFn | null = null;
let _onOutput: OutputFn | null = null;
let _runScene: RunSceneFn | null = null;
let _speak: SpeakFn | null = null;

async function execute(automation: Automation): Promise<void> {
    Logger.info(`Automation trigger: "${automation.name}" (${automation.id})`);
    try {
        if (automation.action.type === 'scene') {
            if (!_runScene) {
                Logger.warn(`Automation "${automation.name}": no scene runner`);
                return;
            }
            const result = await _runScene(automation.action.sceneId);
            if (!result.success)
                Logger.warn(
                    `Automation "${automation.name}": scene error — ${result.error}`,
                );
            if (automation.notify && _speak) await _speak(automation.notify);
        } else {
            if (!_onOrder) return;
            const response = await _onOrder(automation.action.text);
            if (_onOutput && response)
                await _onOutput(response, automation.action.output ?? 'cast');
        }
    } catch (err) {
        Logger.error(`Automation "${automation.name}" failed: ${err}`);
    }
    // Historise tout déclenchement effectif (y compris si l'action a levé une
    // exception catchée ci-dessus) afin que la garde proactive anti-conflit
    // sache qu'une automation a agi sur ce domaine. Les early-returns ci-dessus
    // (dépendance non câblée) sortent de la fonction et ne sont donc pas historisés.
    appendToHistory(automation);
    // delay = one-shot : supprime après exécution
    if (automation.trigger.type === 'delay') {
        deleteAutomation(automation.id);
    }
}

function scheduleAutomation(automation: Automation): void {
    cancelAutomation(automation.id);

    if (automation.trigger.type === 'cron') {
        if (!cron.validate(automation.trigger.expr)) {
            Logger.warn(
                `Invalid cron for "${automation.name}": ${automation.trigger.expr}`,
            );
            return;
        }
        const task = cron.schedule(
            automation.trigger.expr,
            () => void execute(automation),
            { timezone: 'Europe/Paris' },
        );
        _cronTasks.set(automation.id, task);
    } else {
        const remaining = automation.trigger.fireAt - Date.now();
        if (remaining <= 0) {
            Logger.info(
                `Automation "${automation.name}": delay expired at startup, removing`,
            );
            deleteAutomation(automation.id);
            return;
        }
        const timeout = setTimeout(() => void execute(automation), remaining);
        _timeouts.set(automation.id, timeout);
    }
}

function cancelAutomation(id: string): void {
    const task = _cronTasks.get(id);
    if (task) {
        task.stop();
        _cronTasks.delete(id);
    }
    const timeout = _timeouts.get(id);
    if (timeout) {
        clearTimeout(timeout);
        _timeouts.delete(id);
    }
}

export function initAutomations(
    onOrder: OrderFn,
    onOutput: OutputFn,
    runScene: RunSceneFn,
    speak: SpeakFn,
): void {
    _onOrder = onOrder;
    _onOutput = onOutput;
    _runScene = runScene;
    _speak = speak;

    const automations = loadAutomations();
    let active = 0;
    for (const a of automations) {
        if (a.enabled) {
            scheduleAutomation(a);
            active++;
        }
    }
    Logger.info(`Automations: ${active} active loaded`);
}
