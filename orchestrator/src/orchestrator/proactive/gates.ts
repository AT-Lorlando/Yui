import type { Importance, Chattiness } from './types';

const RANK: Record<Importance, number> = {
    info: 0,
    utile: 1,
    urgent: 2,
    critique: 3,
};

const THRESHOLD: Record<Chattiness, number> = {
    discret: 2, // urgent+
    normal: 1, // utile+
    bavard: 0, // info+
};

export function importanceRank(i: Importance): number {
    return RANK[i];
}

export function passesThreshold(i: Importance, c: Chattiness): boolean {
    return RANK[i] >= THRESHOLD[c];
}

export function hmToMinutes(hm: string): number {
    const [h, m] = hm.split(':').map((n) => parseInt(n, 10));
    return h * 60 + (m || 0);
}

export function isQuietHours(
    date: Date,
    q: { start: string; end: string },
): boolean {
    const t = date.getHours() * 60 + date.getMinutes();
    const start = hmToMinutes(q.start);
    const end = hmToMinutes(q.end);
    if (start === end) return false;
    if (start < end) return t >= start && t < end;
    return t >= start || t < end; // passe minuit
}
