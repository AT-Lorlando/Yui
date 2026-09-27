// Collecte pure des faits d'un point : retenus (file `held`) + situation
// courante + faits externes déjà mis en forme (`extra`, passthrough — les
// connecteurs les fournissent tels quels, aucune convention de mapping ici).
import * as crypto from 'crypto';
import type { Event, EventKind } from '../events';
import { eventKey, factsFingerprint } from '../events';
import type { Situation } from '../situation';
import type { Importance } from '../types';
import type { MomentKind } from '../moments';
import type { SaidNature } from '../said';

export interface BriefFact {
    subject: string; // clé mémoire : `source:key` pour un événement, sinon préfixée (`situation:`, `postit:`)
    text: string; // une ligne factuelle, telle que le LLM la reçoit
    importance: Importance;
    at: number; // ancienneté (tri)
    nature: SaidNature; // durée « dit »
    fingerprint: string;
    /** clé de la file des retenus à retirer si dit (événements retenus seulement) */
    heldKey?: string;
}

export interface BriefInputs {
    momentKind: MomentKind | 'on-demand';
    momentFacts: string; // texte du détecteur ('' à la demande)
    held: Event[];
    situation: Situation | null;
    /** Faits externes déjà mis en forme (post-its, changements d'agenda) — fournis par les snapshots des connecteurs */
    extra?: BriefFact[];
    scope?: 'since-last' | 'today' | 'pending';
}

const KIND_TO_NATURE: Record<EventKind, SaidNature> = {
    alert: 'alert',
    request: 'request',
    digest: 'digest',
    info: 'info',
};

function fingerprintOf(text: string): string {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function heldToFact(e: Event): BriefFact {
    const key = eventKey(e);
    return {
        subject: key,
        text: e.subject + (e.facts.length ? ' — ' + e.facts.join(' ; ') : ''),
        importance: e.importance,
        at: e.at,
        nature: KIND_TO_NATURE[e.kind],
        fingerprint: factsFingerprint(e),
        heldKey: key,
    };
}

function agendaFacts(s: Situation): BriefFact[] {
    return s.agenda.map((ev) => {
        const startPart = ev.start ? ` à ${ev.start}` : '';
        const locPart = ev.location ? ` (${ev.location})` : '';
        const text = `« ${ev.title} »${startPart}${locPart}`;
        return {
            subject: `situation:agenda-today-${ev.date}-${ev.title}`,
            text,
            importance: 'utile' as Importance,
            at: s.at,
            nature: 'agenda-today' as SaidNature,
            fingerprint: fingerprintOf(text),
        };
    });
}

function parcelFacts(s: Situation): BriefFact[] {
    return s.parcels.map((p) => {
        const text = `Colis « ${p.label} » : ${p.status}`;
        return {
            subject: `situation:parcel-${p.label}-${p.status}`,
            text,
            importance: 'info' as Importance,
            at: s.at,
            nature: 'info' as SaidNature,
            fingerprint: fingerprintOf(text),
        };
    });
}

function mailFacts(s: Situation): BriefFact[] {
    return s.mailActions.map((subject) => {
        const text = `Mail à traiter : « ${subject} »`;
        return {
            subject: `situation:mail-${subject}`,
            text,
            importance: 'utile' as Importance,
            at: s.at,
            nature: 'request' as SaidNature,
            fingerprint: fingerprintOf(text),
        };
    });
}

/** Faits pur, sans I/O. `momentFacts` n'est PAS un fait : il est passé au
 *  prompt à part (contexte du détecteur de moment). */
export function collectFacts(input: BriefInputs, _now: number): BriefFact[] {
    const out: BriefFact[] = input.held.map(heldToFact);

    if (input.situation) {
        const includeAgenda = input.scope !== 'pending';
        const includeMail = input.scope !== 'today';
        out.push(...parcelFacts(input.situation));
        if (includeAgenda) out.push(...agendaFacts(input.situation));
        if (includeMail) out.push(...mailFacts(input.situation));
    }

    if (input.extra) out.push(...input.extra);

    return out;
}
