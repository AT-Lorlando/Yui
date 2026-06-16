import fs from 'fs';
import path from 'path';
import Logger from '../logger';
import { dataPath } from '@yui/shared';
import type { SceneAction, CallTool, SceneContext } from './scenes';
import { runActionList } from './scenes';
import type { PresenceEventType } from './presence';

const RULES_FILE = dataPath('presence-rules.json');

const EVENT_TYPES: PresenceEventType[] = [
    'arrival',
    'departure',
    'network-join',
];

export interface PresenceRule {
    id: string;
    name: string;
    enabled: boolean;
    trigger: PresenceEventType;
    actions: SceneAction[];
}

/** Pure : règles activées dont le trigger matche. */
export function rulesForEvent(
    rules: PresenceRule[],
    type: PresenceEventType,
): PresenceRule[] {
    return rules.filter((r) => r.enabled && r.trigger === type);
}

/** Construit les règles par défaut à partir des anciennes env scene ids. */
export function seedRules(
    arrivalScene: string | undefined,
    departureScene: string | undefined,
): PresenceRule[] {
    const rules: PresenceRule[] = [];
    if (arrivalScene) {
        rules.push({
            id: 'arrival-scene',
            name: 'Scène retour à la maison',
            enabled: true,
            trigger: 'arrival',
            actions: [{ tool: 'scene_trigger', args: { id: arrivalScene } }],
        });
    }
    if (departureScene) {
        rules.push({
            id: 'departure-scene',
            name: 'Scène départ',
            enabled: true,
            trigger: 'departure',
            actions: [{ tool: 'scene_trigger', args: { id: departureScene } }],
        });
    }
    rules.push({
        id: 'music-to-speakers',
        name: 'Musique du tél → enceintes',
        enabled: true,
        trigger: 'network-join',
        actions: [{ tool: 'transfer_playback_to_speakers', args: {} }],
    });
    return rules;
}

/** Valide + normalise une liste de règles ; throw si invalide. */
export function validateRules(input: unknown): PresenceRule[] {
    if (!Array.isArray(input)) throw new Error('rules must be an array');
    const seen = new Set<string>();
    return input.map((r: any) => {
        if (!r || typeof r.id !== 'string' || !r.id)
            throw new Error('rule.id required');
        if (seen.has(r.id)) throw new Error(`duplicate rule id: ${r.id}`);
        seen.add(r.id);
        if (!EVENT_TYPES.includes(r.trigger))
            throw new Error(`bad trigger: ${r.trigger}`);
        if (!Array.isArray(r.actions))
            throw new Error('rule.actions must be an array');
        return {
            id: r.id,
            name: typeof r.name === 'string' ? r.name : r.id,
            enabled: r.enabled !== false,
            trigger: r.trigger,
            actions: r.actions as SceneAction[],
        };
    });
}

export function loadRules(file = RULES_FILE): PresenceRule[] {
    try {
        return validateRules(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch (e) {
        Logger.warn(`[presence] presence-rules.json invalid/absent — ${e}`);
        return [];
    }
}

export function saveRules(
    rules: PresenceRule[],
    file = RULES_FILE,
): PresenceRule[] {
    const valid = validateRules(rules);
    fs.writeFileSync(file, JSON.stringify(valid, null, 2));
    return valid;
}

/** Crée le fichier par seed si absent ; renvoie les règles courantes. */
export function ensureRulesFile(
    arrivalScene: string | undefined,
    departureScene: string | undefined,
    file = RULES_FILE,
): PresenceRule[] {
    if (!fs.existsSync(file)) {
        const seeded = seedRules(arrivalScene, departureScene);
        fs.writeFileSync(file, JSON.stringify(seeded, null, 2));
        Logger.info('[presence] seeded data/presence-rules.json');
        return seeded;
    }
    return loadRules(file);
}

export interface PresenceRulesEngine {
    handleEvent(type: PresenceEventType): void;
    list(): PresenceRule[];
    replace(rules: PresenceRule[]): PresenceRule[];
    stop(): void;
}

/** Engine : exécute les actions des règles matchant un event, via runActionList. */
export function createPresenceRulesEngine(deps: {
    callTool: CallTool;
    context: () => SceneContext;
    arrivalScene?: string;
    departureScene?: string;
}): PresenceRulesEngine {
    let rules = ensureRulesFile(deps.arrivalScene, deps.departureScene);
    let watcher: fs.FSWatcher | null = null;
    try {
        watcher = fs.watch(RULES_FILE, { persistent: false }, () => {
            const next = loadRules();
            if (next.length) rules = next;
        });
    } catch {
        /* fichier peut ne pas exister au moment du watch — ignoré */
    }

    return {
        handleEvent(type: PresenceEventType): void {
            const matched = rulesForEvent(rules, type);
            if (!matched.length) return;
            Logger.info(
                `[presence] event '${type}' → ${matched.length} rule(s)`,
            );
            for (const rule of matched) {
                void runActionList(
                    rule.actions,
                    `rule:${rule.id}`,
                    deps.callTool,
                    deps.context(),
                ).catch((e) =>
                    Logger.warn(`[presence] rule ${rule.id} failed: ${e}`),
                );
            }
        },
        list: () => rules,
        replace(next: PresenceRule[]): PresenceRule[] {
            rules = saveRules(next);
            return rules;
        },
        stop(): void {
            if (watcher) watcher.close();
        },
    };
}
