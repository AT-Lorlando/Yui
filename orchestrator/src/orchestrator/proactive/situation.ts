// Journal de situation — la « mémoire de travail » de la proactivité.
//
// Un instantané compact de la vie de la maison (présence, agenda proche,
// lumières, porte, colis, tri courrier) est reconstruit périodiquement à
// partir des sources existantes, persisté, et surtout DIFFÉRENCIÉ : le juge
// LLM raisonne sur « qu'est-ce qui a changé » plutôt que sur un dump complet
// à chaque évaluation — moins de tokens, moins de radotage.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import { fetchAgendaEvents } from '../agendaSecretary';
import type { AgendaEvent } from '../agendaSecretary';
import { listParcels } from '../deliveries/tracker';

export interface SituationEvent {
    title: string;
    date: string;
    start: string | null;
    location: string | null;
}

export interface Situation {
    at: number;
    presence: string;
    /** Lumières allumées (noms) — vide = tout éteint. */
    lightsOn: string[];
    doorLocked: boolean | null;
    /** Événements des prochaines 24 h. */
    agenda: SituationEvent[];
    /** Colis actifs (pas encore livrés/archivés). */
    parcels: Array<{ label: string; status: string }>;
    /** Tri courrier : mails « action requise » en attente (si concierge actif). */
    mailActions: string[];
    musicPlaying: boolean;
}

export interface SituationDeps {
    callTool: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>;
    presenceState: () => string;
    now?: () => number;
}

const FILE = dataPath('situation.json');

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

/** Mails « action » en attente d'après l'état du concierge (best-effort). */
function readMailActions(): string[] {
    try {
        const raw = JSON.parse(
            fs.readFileSync(dataPath('mail-triage.json'), 'utf-8'),
        );
        const proposals = Array.isArray(raw?.proposals) ? raw.proposals : [];
        return proposals
            .filter((p: any) => p?.category === 'action')
            .map((p: any) => String(p.subject ?? ''))
            .filter(Boolean)
            .slice(0, 10);
    } catch {
        return [];
    }
}

export async function buildSituation(deps: SituationDeps): Promise<Situation> {
    const now = deps.now?.() ?? Date.now();
    const nowDate = new Date(now);

    const [lights, doors, events, playback] = await Promise.all([
        safe(() => deps.callTool('list_lights') as Promise<any[]>, []),
        safe(() => deps.callTool('list_doors') as Promise<any[]>, []),
        safe(
            () => fetchAgendaEvents(deps.callTool, nowDate),
            [] as AgendaEvent[],
        ),
        safe(() => deps.callTool('get_playback_state') as Promise<any>, null),
    ]);

    const in24h = (ev: AgendaEvent): boolean => {
        const start = new Date(
            `${ev.date}T${ev.start ?? '00:00'}:00`,
        ).getTime();
        return start >= now - 3600_000 && start <= now + 24 * 3600_000;
    };

    return {
        at: now,
        presence: deps.presenceState(),
        lightsOn: (Array.isArray(lights) ? lights : [])
            .filter((l: any) => l?.state?.on ?? l?.on)
            .map((l: any) => String(l.name ?? l.id)),
        doorLocked: (() => {
            const d = Array.isArray(doors) ? doors[0] : null;
            const st = d?.state?.stateName ?? d?.stateName;
            if (st === 'locked') return true;
            if (st === 'unlocked' || st === 'unlatched') return false;
            return null;
        })(),
        agenda: events
            .filter(in24h)
            .slice(0, 10)
            .map((ev) => ({
                title: ev.title,
                date: ev.date,
                start: ev.start,
                location: ev.location,
            })),
        parcels: listParcels()
            // Les livrés récents restent visibles 12 h — le moment « retour »
            // s'en sert (« un colis a été livré pendant ton absence »).
            .filter(
                (p) =>
                    p.status !== 'delivered' ||
                    now - p.updatedAt < 12 * 3600_000,
            )
            .slice(0, 8)
            .map((p) => ({
                label: String(p.content ?? p.label ?? p.tracking ?? 'colis'),
                status: String(p.status ?? '?'),
            })),
        mailActions: readMailActions(),
        musicPlaying: playback?.playing === true,
    };
}

/** Deltas lisibles entre deux instantanés — la matière première du juge. */
export function diffSituation(
    prev: Situation | null,
    next: Situation,
): string[] {
    if (!prev) return ['premier instantané'];
    const d: string[] = [];
    if (prev.presence !== next.presence) {
        d.push(`présence : ${prev.presence} → ${next.presence}`);
    }
    if (prev.doorLocked !== next.doorLocked && next.doorLocked !== null) {
        d.push(`porte : ${next.doorLocked ? 'verrouillée' : 'déverrouillée'}`);
    }
    const prevOn = new Set(prev.lightsOn);
    const nextOn = new Set(next.lightsOn);
    if (prev.lightsOn.length === 0 && next.lightsOn.length > 0) {
        d.push(`premières lumières allumées (${next.lightsOn.join(', ')})`);
    } else if (prev.lightsOn.length > 0 && next.lightsOn.length === 0) {
        d.push('toutes les lumières éteintes');
    }
    void prevOn;
    void nextOn;
    const prevParcels = new Map(prev.parcels.map((p) => [p.label, p.status]));
    for (const p of next.parcels) {
        const old = prevParcels.get(p.label);
        if (old === undefined) d.push(`nouveau colis suivi : ${p.label}`);
        else if (old !== p.status)
            d.push(`colis « ${p.label} » : ${old} → ${p.status}`);
    }
    const prevMail = new Set(prev.mailActions);
    for (const m of next.mailActions) {
        if (!prevMail.has(m)) d.push(`mail à traiter : « ${m} »`);
    }
    if (prev.musicPlaying !== next.musicPlaying) {
        d.push(next.musicPlaying ? 'musique lancée' : 'musique arrêtée');
    }
    return d;
}

/** Résumé compact pour le prompt du juge. */
export function summarizeSituation(s: Situation): string {
    const t = new Date(s.at);
    const lines = [
        `Il est ${t.getHours()}h${String(t.getMinutes()).padStart(
            2,
            '0',
        )}, Jérémy est ${s.presence === 'home' ? 'à la maison' : 'absent'}.`,
        s.lightsOn.length
            ? `Lumières allumées : ${s.lightsOn.slice(0, 6).join(', ')}${
                  s.lightsOn.length > 6 ? '…' : ''
              }.`
            : 'Toutes les lumières sont éteintes.',
    ];
    if (s.doorLocked !== null) {
        lines.push(`Porte ${s.doorLocked ? 'verrouillée' : 'déverrouillée'}.`);
    }
    if (s.musicPlaying) lines.push('Musique en cours.');
    if (s.agenda.length) {
        lines.push(
            `Agenda 24h : ${s.agenda
                .map((e) => `${e.title}${e.start ? ` à ${e.start}` : ''}`)
                .join(' ; ')}.`,
        );
    }
    if (s.parcels.length) {
        lines.push(
            `Colis : ${s.parcels
                .map((p) => `${p.label} (${p.status})`)
                .join(' ; ')}.`,
        );
    }
    if (s.mailActions.length) {
        lines.push(
            `Mails à traiter : ${s.mailActions.slice(0, 5).join(' ; ')}.`,
        );
    }
    return lines.join('\n');
}

export function loadSituation(file: string = FILE): Situation | null {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

export function saveSituation(s: Situation, file: string = FILE): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(s));
    } catch (err) {
        Logger.warn(`proactive: situation non persistée — ${err}`);
    }
}
