// « Mes playlists » — registre des playlists Spotify favorites de Jérémy :
// playlists du compte épinglées ET liens collés pour celles que l'API ne
// liste pas (playlists générées par Spotify, « Radio Montée »).
// Fichier data/config/spotify-playlists.json (non versionné). Lu aussi par
// mcp-spotify (play_playlist les résout en premier, get_my_playlists les
// liste en tête), édité depuis la page Musique de l'app.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';

export interface LinkedPlaylist {
    id: string;
    name: string;
    /** Toujours `spotify:playlist:<id>`. */
    uri: string;
    owner?: string;
    image?: string;
    tracks?: number;
    source: 'account' | 'link';
    addedAt: number;
}

const FILE = () => dataPath('spotify-playlists.json');
export const MAX_NAME = 80;
export const MAX_ITEMS = 60;

const ID_RE = /^[0-9A-Za-z]{22}$/;
const URI_RE = /^spotify:(?:user:[^:]+:)?playlist:([0-9A-Za-z]{22})$/;
const URL_RE =
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:user\/[^/]+\/)?playlist\/([0-9A-Za-z]{22})(?:[/?#].*)?$/i;

/** Lien, URI ou id Spotify → `spotify:playlist:<id>` ; null sinon. */
export function toPlaylistUri(ref: string): string | null {
    const s = String(ref ?? '').trim();
    if (ID_RE.test(s)) return `spotify:playlist:${s}`;
    const m = URI_RE.exec(s) ?? URL_RE.exec(s);
    return m ? `spotify:playlist:${m[1]}` : null;
}

export function slugify(name: string): string {
    return name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

/**
 * Valide une entrée. Pur, testé. `uri` accepte lien/URI/id ; une playlist
 * déjà présente (même uri) est refusée à la création mais acceptée en
 * modification de la même entrée (renommage).
 */
export function normalizeLinked(
    input: Partial<LinkedPlaylist> & { uri?: string },
    existing: LinkedPlaylist[],
    now = Date.now(),
): LinkedPlaylist {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('nom requis');
    if (name.length > MAX_NAME)
        throw new Error(`nom trop long (${MAX_NAME} caractères max)`);
    const uri = toPlaylistUri(String(input.uri ?? ''));
    if (!uri)
        throw new Error('lien Spotify invalide (lien, URI ou id de playlist)');
    let id = typeof input.id === 'string' ? input.id.trim() : '';
    const current = id ? existing.find((p) => p.id === id) : undefined;
    const dup = existing.find((p) => p.uri === uri && p !== current);
    if (dup) throw new Error(`déjà dans les favoris : ${dup.name}`);
    if (!current && existing.length >= MAX_ITEMS)
        throw new Error(`${MAX_ITEMS} favoris maximum`);
    if (!id) {
        const base = slugify(name) || 'playlist';
        id = base;
        for (let n = 2; existing.some((p) => p.id === id); n++)
            id = `${base}-${n}`;
    }
    const source: LinkedPlaylist['source'] =
        input.source === 'account' ? 'account' : 'link';
    return {
        id,
        name,
        uri,
        ...(input.owner ? { owner: String(input.owner).slice(0, 80) } : {}),
        ...(input.image && /^https?:\/\//.test(String(input.image))
            ? { image: String(input.image) }
            : {}),
        ...(Number.isFinite(Number(input.tracks)) && Number(input.tracks) > 0
            ? { tracks: Math.round(Number(input.tracks)) }
            : {}),
        source: current?.source ?? source,
        addedAt: current?.addedAt ?? now,
    };
}

function readFile(): LinkedPlaylist[] {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

function writeFile(list: LinkedPlaylist[]): void {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(list, null, 2));
}

export function listLinked(): LinkedPlaylist[] {
    return readFile();
}

export function upsertLinked(
    input: Partial<LinkedPlaylist> & { uri?: string },
): LinkedPlaylist {
    const list = readFile();
    const next = normalizeLinked(input, list);
    const i = list.findIndex((p) => p.id === next.id);
    if (i >= 0) list[i] = next;
    else list.push(next);
    writeFile(list);
    return next;
}

export function deleteLinked(id: string): boolean {
    const list = readFile();
    const kept = list.filter((p) => p.id !== id);
    if (kept.length === list.length) return false;
    writeFile(kept);
    return true;
}

/** Réordonne : les ids donnés d'abord (dans cet ordre), le reste ensuite. */
export function reorderLinked(ids: string[]): LinkedPlaylist[] {
    const list = readFile();
    const byId = new Map(list.map((p) => [p.id, p]));
    const ordered: LinkedPlaylist[] = [];
    for (const id of ids) {
        const p = byId.get(id);
        if (p && !ordered.includes(p)) ordered.push(p);
    }
    for (const p of list) if (!ordered.includes(p)) ordered.push(p);
    writeFile(ordered);
    return ordered;
}
