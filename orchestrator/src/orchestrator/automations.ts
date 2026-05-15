import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Logger from '../logger';

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
}

export type CreateAutomationInput = Omit<Automation, 'id' | 'createdAt'>;

// ── Storage ────────────────────────────────────────────────────────────────────

const AUTOMATIONS_FILE = path.resolve(process.cwd(), 'data/automations.json');
const SCHEDULES_FILE   = path.resolve(process.cwd(), 'data/schedules.json');

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
    if (!fs.existsSync(SCHEDULES_FILE))  return;
    try {
        const raw = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf-8')) as LegacySchedule[];
        // Oneshot schedules should have already fired — skip them
        const automations: Automation[] = raw
            .filter((s) => !s.oneshot)
            .map((s) => ({
                id:        s.id,
                name:      s.name,
                trigger:   { type: 'cron' as const, expr: s.cron },
                action:    { type: 'prompt' as const, text: s.prompt, ...(s.output ? { output: s.output } : {}) },
                notify:    null,
                enabled:   s.enabled,
                createdAt: s.createdAt ?? Date.now(),
            }));
        ensureDataDir();
        fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(automations, null, 2));
        Logger.info(`Migrated ${automations.length} schedule(s) → automations.json`);
    } catch (err) {
        Logger.warn(`Migration from schedules.json failed: ${err}`);
    }
}

// ── Read / write ───────────────────────────────────────────────────────────────

export function loadAutomations(): Automation[] {
    migrateIfNeeded();
    try {
        if (!fs.existsSync(AUTOMATIONS_FILE)) return [];
        return JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf-8')) as Automation[];
    } catch {
        return [];
    }
}

function saveAutomations(automations: Automation[]): void {
    ensureDataDir();
    fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(automations, null, 2));
}

// ── CRUD (runtime calls are wired in Task 2) ───────────────────────────────────

/** scheduleAutomation / cancelAutomation are defined in the runtime section below */
declare function scheduleAutomation(a: Automation): void;
declare function cancelAutomation(id: string): void;

export function addAutomation(input: CreateAutomationInput): Automation {
    const automation: Automation = { ...input, id: crypto.randomUUID().slice(0, 8), createdAt: Date.now() };
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

export function toggleAutomation(id: string): string {
    const automations = loadAutomations();
    const automation = automations.find((a) => a.id === id);
    if (!automation) return `Automation "${id}" introuvable.`;
    automation.enabled = !automation.enabled;
    saveAutomations(automations);
    if (automation.enabled) scheduleAutomation(automation);
    else cancelAutomation(id);
    return `Automation "${automation.name}" ${automation.enabled ? 'activée' : 'désactivée'}.`;
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
