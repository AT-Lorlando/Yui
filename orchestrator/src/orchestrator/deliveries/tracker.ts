import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { dataPath } from '@yui/shared';
import Logger from '../../logger';
import {
    carrierFromSender,
    type Carrier,
    type DetectedParcel,
} from './carriers';
import {
    queryCarrier,
    type ParcelStatus,
    type ProviderUpdate,
} from './providers';

/**
 * Registre des colis suivis (data/state/deliveries.json).
 *
 * Alimenté par les mails (watcher livraisons) et à la main (POST
 * /deliveries). Les providers transporteur raffinent le statut entre deux
 * mails. Chaque transition de statut est mise en file
 * (`takeTransitions`) — le watcher proactif la consomme pour notifier,
 * qu'elle vienne d'un poll, d'un mail ou d'un ajout manuel.
 */

export interface Parcel {
    id: string;
    tracking: string;
    carrier: Carrier;
    /** D'où il vient : « ASOS », « AMAZON », sujet du mail, saisie manuelle. */
    label?: string;
    source: 'mail' | 'manuel';
    status: ParcelStatus;
    estimatedDate?: string;
    url?: string;
    /** Contenu du colis, corrélé aux mails du marchand (content.ts). */
    content?: string;
    contentConfidence?: 'sûr' | 'probable';
    /** Mail marchand apparié — évite qu'un autre colis le réclame. */
    contentMailId?: string;
    /** Tentatives de corrélation infructueuses (on abandonne à 3). */
    contentAttempts?: number;
    /** Du plus récent au plus ancien, borné. */
    events: { date: string; label: string }[];
    createdAt: number;
    updatedAt: number;
    lastCheckedAt?: number;
}

export interface Transition {
    parcel: Parcel;
    from: ParcelStatus;
    to: ParcelStatus;
}

const FILE = () => dataPath('deliveries.json');
const MAX_EVENTS = 20;
/** Un colis livré reste visible 3 jours puis disparaît de la liste. */
const KEEP_DELIVERED_MS = 3 * 86_400_000;
/** Fréquence max d'interrogation d'un transporteur par colis. */
const CHECK_INTERVAL_MS = 20 * 60_000;

const STATUS_RANK: Record<ParcelStatus, number> = {
    announced: 0,
    shipped: 1,
    in_transit: 2,
    out_for_delivery: 3,
    pickup_ready: 3,
    problem: 3,
    delivered: 4,
};

let transitions: Transition[] = [];

function load(): Parcel[] {
    try {
        if (!fs.existsSync(FILE())) return [];
        return JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as Parcel[];
    } catch (e) {
        Logger.warn(`deliveries: registre illisible — ${e}`);
        return [];
    }
}

function save(parcels: Parcel[]): void {
    fs.writeFileSync(FILE(), JSON.stringify(parcels, null, 2));
}

function prune(parcels: Parcel[], now: number): Parcel[] {
    return parcels.filter(
        (p) =>
            p.status !== 'delivered' || now - p.updatedAt < KEEP_DELIVERED_MS,
    );
}

function setStatus(parcel: Parcel, next: ParcelStatus, now: number): void {
    if (next === parcel.status) return;
    // Un mail relu ne doit pas faire reculer un colis (livré → en transit).
    if (STATUS_RANK[next] < STATUS_RANK[parcel.status]) return;
    transitions.push({ parcel, from: parcel.status, to: next });
    parcel.status = next;
    parcel.updatedAt = now;
}

function applyUpdate(parcel: Parcel, up: ProviderUpdate, now: number): void {
    setStatus(parcel, up.status, now);
    if (up.events.length) parcel.events = up.events.slice(0, MAX_EVENTS);
    if (up.estimatedDate) parcel.estimatedDate = up.estimatedDate;
    // L'expéditeur vu par le transporteur (AMAZON, ASOS…) est plus parlant
    // qu'un label qui n'est que le nom du transporteur lui-même.
    if (up.sender && (!parcel.label || carrierFromSender(parcel.label))) {
        parcel.label = up.sender;
    }
    parcel.lastCheckedAt = now;
}

export function listParcels(): Parcel[] {
    const now = Date.now();
    return prune(load(), now).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Transitions accumulées depuis le dernier appel (et vide la file). */
export function takeTransitions(): Transition[] {
    const out = transitions;
    transitions = [];
    return out;
}

/**
 * Enregistre/actualise un colis vu dans un mail. Le statut mail ne fait
 * jamais reculer un statut provider plus avancé.
 */
export function upsertFromMail(
    detected: DetectedParcel,
    info: { status: ParcelStatus; label?: string; estimatedDate?: string },
): Parcel {
    const now = Date.now();
    const parcels = prune(load(), now);
    let parcel = parcels.find((p) => p.tracking === detected.tracking);
    if (!parcel) {
        parcel = {
            id: randomBytes(4).toString('hex'),
            tracking: detected.tracking,
            carrier: detected.carrier,
            label: info.label,
            source: 'mail',
            status: info.status,
            url: detected.url,
            events: [],
            createdAt: now,
            updatedAt: now,
        };
        parcels.push(parcel);
        transitions.push({ parcel, from: 'announced', to: info.status });
    } else {
        setStatus(parcel, info.status, now);
        if (detected.url && !parcel.url) parcel.url = detected.url;
        if (info.label && !parcel.label) parcel.label = info.label;
    }
    if (info.estimatedDate) parcel.estimatedDate = info.estimatedDate;
    save(parcels);
    return parcel;
}

export async function addManual(input: {
    tracking: string;
    carrier?: Carrier;
    label?: string;
    url?: string;
}): Promise<Parcel> {
    const now = Date.now();
    const parcels = prune(load(), now);
    const tracking = input.tracking.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(tracking)) {
        throw new Error('Numéro de suivi invalide');
    }
    let parcel = parcels.find((p) => p.tracking === tracking);
    if (!parcel) {
        parcel = {
            id: randomBytes(4).toString('hex'),
            tracking,
            carrier: input.carrier ?? guessCarrier(tracking),
            label: input.label,
            source: 'manuel',
            status: 'announced',
            url: input.url,
            events: [],
            createdAt: now,
            updatedAt: now,
        };
        parcels.push(parcel);
    } else {
        if (input.label) parcel.label = input.label;
        if (input.carrier) parcel.carrier = input.carrier;
        if (input.url) parcel.url = input.url;
    }
    // Premier état tout de suite si un provider couvre ce transporteur.
    const up = await queryCarrier(parcel.carrier, parcel.tracking, parcel.url);
    if (up) applyUpdate(parcel, up, now);
    save(parcels);
    return parcel;
}

/** Résultat de la corrélation contenu — null compte comme une tentative. */
export function setContent(
    id: string,
    match: {
        content: string;
        confidence: 'sûr' | 'probable';
        mailId: string;
    } | null,
): void {
    const parcels = load();
    const parcel = parcels.find((p) => p.id === id);
    if (!parcel) return;
    if (match) {
        parcel.content = match.content;
        parcel.contentConfidence = match.confidence;
        parcel.contentMailId = match.mailId;
    } else {
        parcel.contentAttempts = (parcel.contentAttempts ?? 0) + 1;
    }
    save(parcels);
}

export function removeParcel(id: string): boolean {
    const parcels = load();
    const next = parcels.filter((p) => p.id !== id);
    if (next.length === parcels.length) return false;
    save(next);
    return true;
}

/** Devine le transporteur d'un numéro saisi à la main. */
export function guessCarrier(tracking: string): Carrier {
    if (/^1Z[A-Z0-9]{16}$/.test(tracking)) return 'ups';
    if (/^[A-Z]{2}\d{9}FR$/.test(tracking)) return 'colissimo';
    if (/^[5-9][A-Z]\d{11}$/.test(tracking)) return 'colissimo';
    if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(tracking)) return 'chronopost';
    if (/^\d{12}$/.test(tracking)) return 'colisprive';
    if (/^\d{8}$/.test(tracking)) return 'mondialrelay';
    return 'inconnu';
}

/**
 * Interroge les providers pour les colis actifs (throttle 20 min/colis).
 * Appelé à chaque tick du watcher — les transitions détectées rejoignent
 * la file. Best-effort.
 */
export async function refreshFromCarriers(): Promise<void> {
    const now = Date.now();
    const parcels = prune(load(), now);
    let dirty = false;
    for (const parcel of parcels) {
        // Un colis déjà livré mérite quand même UNE interrogation (historique
        // + expéditeur, dont dépend la corrélation contenu), puis silence.
        if (parcel.status === 'delivered' && parcel.lastCheckedAt) continue;
        if (now - (parcel.lastCheckedAt ?? 0) < CHECK_INTERVAL_MS) continue;
        const up = await queryCarrier(
            parcel.carrier,
            parcel.tracking,
            parcel.url,
        );
        if (up) applyUpdate(parcel, up, now);
        parcel.lastCheckedAt = now;
        dirty = true;
    }
    if (dirty) save(parcels);
}
