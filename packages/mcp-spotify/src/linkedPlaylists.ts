// « Mes playlists » de Jérémy (data/config/spotify-playlists.json, édité par
// l'orchestrateur via la page Musique) : favoris du compte épinglés et liens
// collés pour les playlists que l'API ne liste pas (« Radio Montée »).
// Lecture à chaque usage (fichier minuscule) : pas de cache à invalider.
import * as fs from 'fs';
import { dataPath } from '@yui/shared';
import type { PlaylistSummary } from './SpotifyController';

export interface LinkedPlaylist extends PlaylistSummary {
    source: 'account' | 'link';
    pinned: true;
}

export function readLinkedPlaylists(): LinkedPlaylist[] {
    try {
        const raw = JSON.parse(
            fs.readFileSync(dataPath('spotify-playlists.json'), 'utf8'),
        );
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(
                (p) =>
                    p &&
                    typeof p.name === 'string' &&
                    typeof p.uri === 'string',
            )
            .map((p) => ({
                id: String(p.uri).split(':').pop() ?? '',
                name: String(p.name),
                owner: p.owner ? String(p.owner) : 'favori',
                uri: String(p.uri),
                tracks: Number(p.tracks ?? 0),
                ...(p.image ? { image: String(p.image) } : {}),
                source: p.source === 'account' ? 'account' : 'link',
                pinned: true as const,
            }));
    } catch {
        return [];
    }
}

/** Favoris en tête, puis le compte sans les doublons (même uri). */
export function mergePlaylists<T extends PlaylistSummary>(
    linked: LinkedPlaylist[],
    account: T[],
): Array<LinkedPlaylist | T> {
    const seen = new Set(linked.map((p) => p.uri));
    return [...linked, ...account.filter((p) => !seen.has(p.uri))];
}
