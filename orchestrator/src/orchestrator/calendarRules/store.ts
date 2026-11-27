// Persistance des règles d'agenda : data/config/calendar-rules.json
// ({rules: [...]}). Absent → []. Illisible ou forme inattendue → RulesFileError.
// Une entrée invalide est ignorée (warn), signalée et conservée à l'écriture.

import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import { localYmd } from '../schedule/dayPlan';
import { CalendarRule, normalizeRule } from './model';

function file(): string {
    return dataPath('calendar-rules.json');
}

/**
 * Fichier présent mais illisible (JSON cassé, forme inattendue). Jamais traité
 * comme « aucune règle » : la sync supprimerait tous les événements futurs, et
 * la prochaine écriture effacerait les règles.
 */
export class RulesFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RulesFileError';
    }
}

interface Loaded {
    rules: CalendarRule[];
    /** Entrées rejetées par normalizeRule, conservées telles quelles. */
    invalidRaw: unknown[];
    /** Ids de ces entrées (quand elles en ont un). */
    invalid: string[];
}

function load(): Loaded {
    const f = file();
    if (!fs.existsSync(f)) return { rules: [], invalidRaw: [], invalid: [] };
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
        throw new RulesFileError(`${f} illisible : ${(e as Error).message}`);
    }
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { rules?: unknown } | null)?.rules)
        ? (raw as { rules: unknown[] }).rules
        : null;
    if (!list)
        throw new RulesFileError(
            `${f} : forme inattendue (attendu {rules: [...]})`,
        );
    const out: Loaded = { rules: [], invalidRaw: [], invalid: [] };
    const seen = new Set<string>();
    for (const entry of list) {
        try {
            // `today` ne sert qu'au `start` par défaut ; une règle stockée a le sien.
            const r = normalizeRule(entry, { today: localYmd(new Date()) });
            if (seen.has(r.id)) throw new Error(`id en double : ${r.id}`);
            seen.add(r.id);
            out.rules.push(r);
        } catch (e) {
            out.invalidRaw.push(entry);
            const id = (entry as { id?: unknown } | null)?.id;
            if (typeof id === 'string' && id && !out.invalid.includes(id))
                out.invalid.push(id);
            Logger.warn(
                `[calendar-rules] règle ignorée : ${(e as Error).message}`,
            );
        }
    }
    return out;
}

function write(rules: CalendarRule[], invalidRaw: unknown[]): void {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    // Les entrées invalides sont réécrites telles quelles : jamais perdues.
    fs.writeFileSync(
        tmp,
        JSON.stringify({ rules: [...rules, ...invalidRaw] }, null, 2),
    );
    fs.renameSync(tmp, f);
}

/** Règles valides. Lève `RulesFileError` si le fichier est illisible. */
export function readRules(): CalendarRule[] {
    return load().rules;
}

/**
 * Règles valides + ids des entrées invalides (leurs événements sont gelés par
 * la sync). Lève `RulesFileError` si le fichier est illisible.
 */
export function readRuleSet(): { rules: CalendarRule[]; invalid: string[] } {
    const { rules, invalid } = load();
    return { rules, invalid };
}

export function createRule(
    raw: unknown,
    today: string = localYmd(new Date()),
): CalendarRule {
    const { rules, invalidRaw, invalid } = load();
    const rule = normalizeRule(raw, { today });
    if (rules.some((r) => r.id === rule.id) || invalid.includes(rule.id))
        throw new Error(`Règle déjà existante : ${rule.id}`);
    rules.push(rule);
    write(rules, invalidRaw);
    return rule;
}

export function updateRule(
    id: string,
    raw: unknown,
    today: string = localYmd(new Date()),
): CalendarRule | null {
    const { rules, invalidRaw } = load();
    const i = rules.findIndex((r) => r.id === id);
    if (i < 0) return null;
    // Sans `start`, la règle garde le sien (sinon il glisserait à aujourd'hui).
    const body =
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null;
    const merged =
        body && body.start === undefined
            ? { ...body, start: rules[i].start }
            : raw;
    const rule = normalizeRule(merged, { id, today });
    rules[i] = rule;
    write(rules, invalidRaw);
    return rule;
}

export function deleteRule(id: string): boolean {
    const { rules, invalidRaw } = load();
    const kept = rules.filter((r) => r.id !== id);
    if (kept.length === rules.length) return false;
    write(kept, invalidRaw);
    return true;
}
