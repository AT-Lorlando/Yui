// Lecture des états d'appareils pour les conditions de scène ({ device, is }).
// Chaque sujet est réduit à un état discret comparable en string. Un sujet
// illisible (device offline, tool en erreur) renvoie 'unknown' — la condition
// vaut alors false, jamais une exception.

import * as fs from 'fs';
import Logger from '../logger';
import { dataPath } from '@yui/shared';
import type { CallTool } from './scenes';

export type DeviceSubject = 'amp' | 'music' | 'tv' | 'lights' | 'door';

export const DEVICE_SUBJECTS: Record<DeviceSubject, string[]> = {
    amp: ['on', 'off'],
    music: ['playing', 'stopped'],
    tv: ['on', 'off'],
    lights: ['on', 'off'],
    door: ['locked', 'unlocked'],
};

/** L'ampli n'a pas de retour d'état : mcp-spotify persiste le dernier ordre IR. */
function readAmpState(): string {
    try {
        const raw = JSON.parse(
            fs.readFileSync(dataPath('amp-state.json'), 'utf-8'),
        );
        return raw.marantz_amp === 'on' ? 'on' : 'off';
    } catch {
        // Jamais piloté depuis le boot → considéré éteint (défaut sûr).
        return 'off';
    }
}

/**
 * Les lumières d'une cible : une pièce, une lampe nommée, ou tout
 * l'appartement si `target` est absent. La comparaison est celle de
 * set_lights (pièce d'abord, puis nom exact, puis nom partiel) pour qu'une
 * condition et l'action qu'elle garde parlent bien du même périmètre.
 */
function lightsOfTarget(lights: any[], target?: string): any[] {
    if (!target || target.toLowerCase() === 'all') return lights;
    const lc = target.toLowerCase().trim();
    const byRoom = lights.filter((l) => (l?.room ?? '').toLowerCase() === lc);
    if (byRoom.length) return byRoom;
    const exact = lights.filter((l) => (l?.name ?? '').toLowerCase() === lc);
    if (exact.length) return exact;
    return lights.filter((l) => (l?.name ?? '').toLowerCase().includes(lc));
}

export async function readDeviceState(
    subject: DeviceSubject,
    callTool: CallTool,
    target?: string,
): Promise<string> {
    try {
        switch (subject) {
            case 'amp':
                return readAmpState();
            case 'music': {
                const s = (await callTool('get_playback_state', {})) as any;
                return s?.playing === true ? 'playing' : 'stopped';
            }
            case 'tv': {
                const s = (await callTool('tv_get_status', {})) as any;
                return s?.power === 'on' || s?.on === true ? 'on' : 'off';
            }
            case 'lights': {
                const all = (await callTool('list_lights', {})) as any[];
                if (!Array.isArray(all)) return 'unknown';
                const lights = lightsOfTarget(all, target);
                // Cible inconnue (pièce renommée, lampe retirée) : 'unknown'
                // plutôt que 'off', sinon une condition "éteint" passerait à
                // tort et l'action se déclencherait sans raison.
                if (!lights.length) return 'unknown';
                return lights.some(
                    (l) => l?.state?.on === true || l?.on === true,
                )
                    ? 'on'
                    : 'off';
            }
            case 'door': {
                const doors = (await callTool('list_doors', {})) as any[];
                if (!Array.isArray(doors) || doors.length === 0)
                    return 'unknown';
                return doors.every(
                    (d) => (d?.state?.stateName ?? d?.stateName) === 'locked',
                )
                    ? 'locked'
                    : 'unlocked';
            }
        }
    } catch (err) {
        Logger.warn(`readDeviceState(${subject}) failed: ${err}`);
        return 'unknown';
    }
}

/**
 * Lecteur avec cache — une exécution de scène ne lit chaque sujet qu'une fois,
 * même si plusieurs actions/branches le testent.
 */
export function createStateReader(callTool: CallTool) {
    const cache = new Map<string, Promise<string>>();
    return (subject: DeviceSubject, target?: string): Promise<string> => {
        const key = `${subject}:${target ?? ''}`;
        let p = cache.get(key);
        if (!p) {
            p = readDeviceState(subject, callTool, target);
            cache.set(key, p);
        }
        return p;
    };
}

export type StateReader = ReturnType<typeof createStateReader>;

/**
 * Snapshot complet pour l'app (tool virtuel _device_states).
 * En plus des sujets globaux, une entrée `lights:<pièce|lampe>` par cible
 * connue — c'est ce qui alimente le « Actuellement : allumé » de l'éditeur
 * quand la condition vise une pièce précise.
 */
export async function readAllDeviceStates(
    callTool: CallTool,
): Promise<Record<string, string>> {
    const subjects = Object.keys(DEVICE_SUBJECTS) as DeviceSubject[];
    const values = await Promise.all(
        subjects.map((s) => readDeviceState(s, callTool)),
    );
    const out: Record<string, string> = Object.fromEntries(
        subjects.map((s, i) => [s, values[i]]),
    );

    try {
        const lights = (await callTool('list_lights', {})) as any[];
        if (Array.isArray(lights)) {
            const targets = new Set<string>();
            for (const l of lights) {
                if (l?.room) targets.add(String(l.room));
                if (l?.name) targets.add(String(l.name));
            }
            for (const t of targets) {
                const group = lightsOfTarget(lights, t);
                out[`lights:${t}`] = group.some(
                    (l) => l?.state?.on === true || l?.on === true,
                )
                    ? 'on'
                    : 'off';
            }
        }
    } catch (err) {
        Logger.warn(`readAllDeviceStates: per-target lights failed: ${err}`);
    }
    return out;
}
