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

export async function readDeviceState(
    subject: DeviceSubject,
    callTool: CallTool,
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
                const lights = (await callTool('list_lights', {})) as any[];
                return Array.isArray(lights) &&
                    lights.some((l) => l?.state?.on === true || l?.on === true)
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
    const cache = new Map<DeviceSubject, Promise<string>>();
    return (subject: DeviceSubject): Promise<string> => {
        let p = cache.get(subject);
        if (!p) {
            p = readDeviceState(subject, callTool);
            cache.set(subject, p);
        }
        return p;
    };
}

export type StateReader = ReturnType<typeof createStateReader>;

/** Snapshot complet pour l'app (tool virtuel _device_states). */
export async function readAllDeviceStates(
    callTool: CallTool,
): Promise<Record<DeviceSubject, string>> {
    const subjects = Object.keys(DEVICE_SUBJECTS) as DeviceSubject[];
    const values = await Promise.all(
        subjects.map((s) => readDeviceState(s, callTool)),
    );
    return Object.fromEntries(subjects.map((s, i) => [s, values[i]])) as Record<
        DeviceSubject,
        string
    >;
}
