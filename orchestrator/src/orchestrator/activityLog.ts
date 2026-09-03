import * as fs from 'fs';
import { dataPath } from '@yui/shared';
import Logger from '../logger';

/**
 * Journal d'activité — « qui a fait quoi, quand » : scènes déclenchées,
 * boutons de télécommande, événements de présence (départs mis au veto
 * compris), automations, ordres au LLM.
 *
 * Répond à « pourquoi ça s'est déclenché tout seul ? » — le besoin est né du
 * faux départ nocturne du 17/08. Ring buffer JSON en data/state, best-effort :
 * une écriture qui échoue ne doit jamais casser l'action qu'elle journalise.
 */
export type ActivityKind =
    | 'scene'
    | 'remote'
    | 'presence'
    | 'automation'
    | 'order';

export interface ActivityEntry {
    ts: number;
    kind: ActivityKind;
    label: string;
    detail?: string;
}

const FILE = () => dataPath('activity-log.json');
const MAX_ENTRIES = 400;

export function logActivity(
    kind: ActivityKind,
    label: string,
    detail?: string,
): void {
    try {
        const entry: ActivityEntry = {
            ts: Date.now(),
            kind,
            label,
            ...(detail ? { detail } : {}),
        };
        const entries = [entry, ...readActivity(MAX_ENTRIES - 1)];
        fs.writeFileSync(FILE(), JSON.stringify(entries));
    } catch (e) {
        Logger.warn(`[activity] log failed: ${e}`);
    }
}

export function readActivity(limit = 100): ActivityEntry[] {
    try {
        if (!fs.existsSync(FILE())) return [];
        const all = JSON.parse(
            fs.readFileSync(FILE(), 'utf-8'),
        ) as ActivityEntry[];
        return all.slice(0, limit);
    } catch {
        return [];
    }
}
