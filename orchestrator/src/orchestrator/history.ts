import * as fs from 'fs';
import * as path from 'path';
import type { AutomationAction } from './automations';
import Logger from '../logger';

export interface AutomationHistoryEntry {
    id: string;
    name: string;
    action: AutomationAction;
    tag?: string;
    firedAt: number;
}

const HISTORY_FILE = path.resolve(
    process.cwd(),
    'data/automation-history.json',
);
const MAX_ENTRIES = 100;

export function loadHistory(): AutomationHistoryEntry[] {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        return JSON.parse(
            fs.readFileSync(HISTORY_FILE, 'utf-8'),
        ) as AutomationHistoryEntry[];
    } catch (err) {
        Logger.warn(
            `Failed to load automation history: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return [];
    }
}

export function appendToHistory(automation: {
    id: string;
    name: string;
    action: AutomationAction;
    tag?: string;
}): void {
    try {
        const entry: AutomationHistoryEntry = {
            id: automation.id,
            name: automation.name,
            action: automation.action,
            tag: automation.tag,
            firedAt: Date.now(),
        };
        const history = [entry, ...loadHistory()].slice(0, MAX_ENTRIES);
        const dir = path.dirname(HISTORY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tempFile = HISTORY_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(history, null, 2));
        fs.renameSync(tempFile, HISTORY_FILE);
    } catch (err) {
        Logger.warn(
            `Failed to append automation history: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}
