// Cycle de scènes — un bouton, N scènes : chaque appui lance la suivante.
//
// Repart de la première quand la pièce est éteinte (rien n'est « en cours »)
// ou quand le dernier appui date trop (on ne reprend pas au milieu d'un cycle
// commencé hier). État par liste de scènes, persisté (`scene-cycle.json`).
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../logger';

export interface CycleState {
    [key: string]: { index: number; at: number };
}

export const DEFAULT_RESET_MIN = 90;

/** Index à lancer maintenant. Pur, testé. */
export function nextCycleIndex(
    state: CycleState,
    key: string,
    count: number,
    now: number,
    opts: { roomOff: boolean; resetMs: number },
): number {
    if (count <= 0) return -1;
    const last = state[key];
    if (!last || opts.roomOff || now - last.at > opts.resetMs) return 0;
    return (last.index + 1) % count;
}

const FILE = () => dataPath('scene-cycle.json');

export function loadCycleState(file: string = FILE()): CycleState {
    try {
        if (fs.existsSync(file))
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
        Logger.warn(`scene-cycle: état illisible — ${err}`);
    }
    return {};
}

export function saveCycleState(st: CycleState, file: string = FILE()): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(st));
    } catch (err) {
        Logger.warn(`scene-cycle: état non persisté — ${err}`);
    }
}
