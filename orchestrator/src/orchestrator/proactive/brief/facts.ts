// Collecte pure des faits d'un point : retenus (file `held`) + situation
// courante + faits externes déjà mis en forme (`extra`, passthrough).
//
// Deux conventions relient les connecteurs au brief sans qu'ils dépendent
// de lui :
// - un retenu peut porter en `facts[0]` un marqueur `nature:<SaidNature>`
//   (durée « dit » choisie par la source, ex. un changement d'agenda
//   lointain se dit une fois pour toutes) — lu ici, jamais montré au LLM ;
// - certaines sections de situation (`sections`, par id de connecteur)
//   deviennent des faits de brief par leur label : `yoji` / « Post-it
//   ancien » → rappel `postit-stale` ; `calendar` / « Demain tôt » →
//   `agenda-today`. Les autres labels restent de la situation.
import * as crypto from 'crypto';
import type { Event, EventKind, Fact } from '../events';
import { eventKey, factsFingerprint } from '../events';
import type { Situation } from '../situation';
import type { Importance } from '../types';
import type { MomentKind } from '../moments';
import type { SaidNature } from '../said';
import { POSTIT_LINE_RE } from '../postits';

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

const NATURE_MARKER =
    /^nature:(alert|request|info|digest|agenda-far|agenda-today|postit-stale)$/;

function fingerprintOf(text: string): string {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** L'empreinte garde le marqueur `nature:` (la source l'émet à chaque fois)
 *  mais ignore la ligne du post-it : le moteur l'ajoute UNE fois, à la
 *  création, et une réémission de la même origine arrive sans elle — elle
 *  doit quand même être reconnue comme déjà dite. Le texte, lui, la garde. */
function heldToFact(e: Event): BriefFact {
    const key = eventKey(e);
    const marker = NATURE_MARKER.exec(e.facts[0] ?? '');
    const facts = marker ? e.facts.slice(1) : e.facts;
    return {
        subject: key,
        text: e.subject + (facts.length ? ' — ' + facts.join(' ; ') : ''),
        importance: e.importance,
        at: e.at,
        nature: marker ? (marker[1] as SaidNature) : KIND_TO_NATURE[e.kind],
        fingerprint: factsFingerprint({
            ...e,
            facts: e.facts.filter((f) => !POSTIT_LINE_RE.test(f)),
        }),
        heldKey: key,
    };
}

function sectionFacts(s: Situation, id: string, label: string): Fact[] {
    return (s.sections?.[id] ?? []).filter((f) => f.label === label);
}

function stalePostitFacts(s: Situation): BriefFact[] {
    return sectionFacts(s, 'yoji', 'Post-it ancien').map((f) => {
        const text = `Post-it qui traîne : ${f.value}`;
        return {
            subject: `postit:${f.key ?? f.value}-stale`,
            text,
            importance: 'utile' as Importance,
            at: s.at,
            nature: 'postit-stale' as SaidNature,
            fingerprint: fingerprintOf(text),
        };
    });
}

function earlyTomorrowFacts(s: Situation): BriefFact[] {
    return sectionFacts(s, 'calendar', 'Demain tôt').map((f) => {
        const text = `Demain tôt : ${f.value}`;
        return {
            subject: `situation:agenda-early-${f.value}`,
            text,
            importance: 'utile' as Importance,
            at: s.at,
            nature: 'agenda-today' as SaidNature,
            fingerprint: fingerprintOf(text),
        };
    });
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
            importance: 'utile' as Importance,
            at: s.at,
            nature: 'info' as SaidNature,
            fingerprint: fingerprintOf(text),
        };
    });
}

/** Pile « à lire » (fact `mail`/« À lire », posé par le connecteur) —
 *  approximation locale, jamais montrée aux points réguliers (since-last,
 *  today) : seulement à la demande explicite du scope "pending". */
function readingPileFacts(s: Situation): BriefFact[] {
    return sectionFacts(s, 'mail', 'À lire').map((f) => ({
        subject: 'situation:mail-reading',
        text: f.value,
        importance: 'info' as Importance,
        at: s.at,
        nature: 'info' as SaidNature,
        fingerprint: fingerprintOf(f.value),
    }));
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
 *  prompt à part (contexte du détecteur de moment). `now` n'est pas encore
 *  utilisé ici — gardé dans la signature pour le composeur qui l'appelle
 *  (filtrage par date à venir, ex. fraîcheur d'un fait de situation). */
export function collectFacts(input: BriefInputs, _now: number): BriefFact[] {
    const out: BriefFact[] = input.held.map(heldToFact);

    if (input.situation) {
        // « today » = ce qui arrive ; « pending » = ce qui attend Jérémy.
        const includeToday = input.scope !== 'pending';
        const includePending = input.scope !== 'today';
        out.push(...parcelFacts(input.situation));
        if (includeToday) {
            out.push(...agendaFacts(input.situation));
            out.push(...earlyTomorrowFacts(input.situation));
        }
        if (includePending) {
            out.push(...mailFacts(input.situation));
            out.push(...stalePostitFacts(input.situation));
        }
        // Scope explicite uniquement — pas "since-last" (includePending le
        // couvre aussi) : la pile à lire ne se dit qu'à la demande de l'état.
        if (input.scope === 'pending') {
            out.push(...readingPileFacts(input.situation));
        }
    }

    if (input.extra) out.push(...input.extra);

    return out;
}
