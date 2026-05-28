import * as fs from 'fs';
import * as path from 'path';
import type { AutomationAction } from './automations';

export interface AutomationHistoryEntry {
    id: string;
    name: string;
    action: AutomationAction;
    firedAt: number;
}

const HISTORY_FILE = path.resolve(process.cwd(), 'data/automation-history.json');
const MAX_ENTRIES = 100;

export function loadHistory(): AutomationHistoryEntry[] {
    try {
        if (!fs.existsSync(HISTORY_FILE)) return [];
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as AutomationHistoryEntry[];
    } catch {
        return [];
    }
}

export function appendToHistory(automation: { id: string; name: string; action: AutomationAction }): void {
    const entry: AutomationHistoryEntry = {
        id: automation.id,
        name: automation.name,
        action: automation.action,
        firedAt: Date.now(),
    };
    const history = [entry, ...loadHistory()].slice(0, MAX_ENTRIES);
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}
