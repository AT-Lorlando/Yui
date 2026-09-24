// Tri automatique des titres likés en playlists par style — porté du projet
// standalone (`npm run sort-likes`) sous forme de tools APP-ONLY, exécutés
// en tâche de fond : sur une grosse bibliothèque le tri dépasse largement le
// timeout d'un appel MCP, donc `likes_sort_start` rend un job et
// `likes_sort_status` en donne l'avancement puis le résultat.
//
// Règles pures dans sortLikesRules.ts (testées) ; jamais de suppression de
// playlist ; l'option `clear` retire des likes UNIQUEMENT ce qui vient
// d'être classé.
import type SpotifyWebApi from 'spotify-web-api-node';
import { chunk } from './playlists';
import { fetchAllUserPlaylists } from './resolvePlaylist';
import {
    ALL_PLAYLISTS,
    RULES,
    NOSTALGIA_PLAYLIST,
    UNSORTED_PLAYLIST,
    NOSTALGIA_YEARS,
    classifyTrack,
} from './sortLikesRules';
import {
    describeError,
    json,
    fail,
    type ToolContext,
    type ToolHandler,
    type ToolDefinition,
    type ToolModule,
} from './types';
import Logger from './logger';

const SAVED_PAGE = 50;
const ARTIST_CHUNK = 50;
const PLAYLIST_PAGE = 100;
const ADD_CHUNK = 100;
const UNLIKE_CHUNK = 50;
const CREATED_DESCRIPTION = 'Titres likés — tri auto (Yui)';
const PREVIEW_LINES = 6;

interface LikedTrack {
    id: string;
    uri: string;
    name: string;
    artist: string;
    artistIds: string[];
    addedAt: string;
}

export interface PlanRow {
    playlist: string;
    /** À ajouter (absents de la playlist). */
    toAdd: number;
    /** Déjà présents. */
    duplicates: number;
    samples: Array<{ artist: string; name: string }>;
    exists: boolean;
}

export interface SortJob {
    id: string;
    mode: 'preview' | 'apply';
    clear: boolean;
    state: 'running' | 'done' | 'error';
    startedAt: number;
    /** Étape courante lisible + progression 0-1 (best-effort). */
    step: string;
    progress: number;
    plan?: PlanRow[];
    summary?: {
        liked: number;
        added: number;
        duplicates: number;
        unliked: number;
        created: string[];
    };
    error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const e = err as {
                statusCode?: number;
                headers?: Record<string, string>;
            };
            const status = e?.statusCode;
            const retryable =
                status === 429 || (status !== undefined && status >= 500);
            if (!retryable || attempt >= 5) throw err;
            const after = Number(e.headers?.['retry-after']);
            const wait =
                status === 429 && Number.isFinite(after)
                    ? (after + 1) * 1000
                    : 1000 * attempt;
            Logger.warn(
                `likes-sort ${label}: HTTP ${status}, retry in ${Math.round(
                    wait / 1000,
                )}s`,
            );
            await sleep(wait);
        }
    }
}

const artistNames = (artists: Array<{ name: string }> | undefined): string =>
    (artists ?? []).map((a) => a.name).join(', ');

async function fetchAllSavedTracks(
    api: SpotifyWebApi,
    onProgress: (p: number) => void,
): Promise<LikedTrack[]> {
    const out: LikedTrack[] = [];
    let offset = 0;
    for (;;) {
        const res = await withRetry('getMySavedTracks', () =>
            api.getMySavedTracks({ limit: SAVED_PAGE, offset }),
        );
        const page = res.body;
        const items = page.items ?? [];
        for (const it of items) {
            const t =
                (it as { item?: SpotifyApi.TrackObjectFull | null }).item ??
                it.track;
            if (!t || !t.id || !t.uri || t.uri.startsWith('spotify:local:'))
                continue;
            out.push({
                id: t.id,
                uri: t.uri,
                name: t.name,
                artist: artistNames(t.artists),
                artistIds: (t.artists ?? [])
                    .map((a) => a.id)
                    .filter((id): id is string => Boolean(id)),
                addedAt: it.added_at,
            });
        }
        offset += items.length;
        onProgress(page.total ? Math.min(1, offset / page.total) : 1);
        if (items.length < SAVED_PAGE || !page.next || offset >= page.total)
            break;
    }
    out.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    return out;
}

async function fetchArtistGenres(
    api: SpotifyWebApi,
    tracks: LikedTrack[],
    onProgress: (p: number) => void,
): Promise<Map<string, string[]>> {
    const ids = Array.from(new Set(tracks.flatMap((t) => t.artistIds)));
    const genres = new Map<string, string[]>();
    let done = 0;
    for (const slice of chunk(ids, ARTIST_CHUNK)) {
        const res = await withRetry('getArtists', () => api.getArtists(slice));
        for (const a of res.body.artists ?? [])
            if (a?.id) genres.set(a.id, a.genres ?? []);
        done += slice.length;
        onProgress(ids.length ? done / ids.length : 1);
    }
    return genres;
}

async function fetchPlaylistTrackUris(
    api: SpotifyWebApi,
    playlistId: string,
): Promise<Set<string>> {
    const uris = new Set<string>();
    let offset = 0;
    for (;;) {
        const res = await withRetry('getPlaylistTracks', () =>
            api.getPlaylistTracks(playlistId, {
                limit: PLAYLIST_PAGE,
                offset,
                fields: 'items(track(uri),item(uri)),next,total',
            }),
        );
        const page = res.body;
        const items = page.items ?? [];
        for (const it of items) {
            const t =
                (it as { item?: { uri?: string } | null }).item ?? it.track;
            if (t?.uri) uris.add(t.uri);
        }
        offset += items.length;
        if (items.length < PLAYLIST_PAGE || !page.next || offset >= page.total)
            break;
    }
    return uris;
}

/** Cœur du tri — utilisé par le job. */
async function runSort(api: SpotifyWebApi, job: SortJob): Promise<void> {
    const now = new Date();
    const set = (step: string, progress: number) => {
        job.step = step;
        job.progress = progress;
    };

    const me = await withRetry('getMe', () => api.getMe());
    const userId = me.body.id;

    set('Lecture des titres likés', 0);
    const tracks = await fetchAllSavedTracks(api, (p) =>
        set('Lecture des titres likés', p * 0.3),
    );
    if (!tracks.length) {
        job.plan = [];
        job.summary = {
            liked: 0,
            added: 0,
            duplicates: 0,
            unliked: 0,
            created: [],
        };
        return;
    }

    set('Genres des artistes', 0.3);
    const genres = await fetchArtistGenres(api, tracks, (p) =>
        set('Genres des artistes', 0.3 + p * 0.3),
    );

    const byPlaylist = new Map<string, LikedTrack[]>();
    for (const t of tracks) {
        const g = new Set<string>();
        for (const id of t.artistIds)
            for (const x of genres.get(id) ?? []) g.add(x);
        const target = classifyTrack({ addedAt: t.addedAt, genres: g }, now);
        byPlaylist.set(target, [...(byPlaylist.get(target) ?? []), t]);
    }
    const plans = ALL_PLAYLISTS.filter((p) => byPlaylist.has(p)).map((p) => ({
        playlist: p,
        tracks: byPlaylist.get(p)!,
    }));

    set('Playlists cibles', 0.62);
    const all = await fetchAllUserPlaylists(api);
    const owned = all.filter((p) => p.owner?.id === userId);
    const ids = new Map<string, string>();
    const created: string[] = [];
    for (const plan of plans) {
        const hit = owned.find((p) => p.name.trim() === plan.playlist);
        if (hit) {
            ids.set(plan.playlist, hit.id);
        } else if (job.mode === 'apply') {
            const res = await withRetry('createPlaylist', () =>
                api.createPlaylist(plan.playlist, {
                    public: false,
                    description: CREATED_DESCRIPTION,
                }),
            );
            ids.set(plan.playlist, res.body.id);
            created.push(plan.playlist);
        } else {
            ids.set(plan.playlist, '');
        }
    }

    set('Doublons', 0.7);
    const rows: PlanRow[] = [];
    const toAdd = new Map<string, LikedTrack[]>();
    let i = 0;
    for (const plan of plans) {
        const id = ids.get(plan.playlist) ?? '';
        const existing = id
            ? await fetchPlaylistTrackUris(api, id)
            : new Set<string>();
        const fresh = plan.tracks.filter((t) => !existing.has(t.uri));
        toAdd.set(plan.playlist, fresh);
        rows.push({
            playlist: plan.playlist,
            toAdd: fresh.length,
            duplicates: plan.tracks.length - fresh.length,
            samples: fresh
                .slice(0, PREVIEW_LINES)
                .map((t) => ({ artist: t.artist, name: t.name })),
            exists: !!id && !created.includes(plan.playlist),
        });
        set('Doublons', 0.7 + (++i / plans.length) * 0.1);
    }
    job.plan = rows;

    if (job.mode === 'preview') {
        job.summary = {
            liked: tracks.length,
            added: rows.reduce((s, r) => s + r.toAdd, 0),
            duplicates: rows.reduce((s, r) => s + r.duplicates, 0),
            unliked: 0,
            created: rows.filter((r) => !r.exists).map((r) => r.playlist),
        };
        return;
    }

    set('Ajout aux playlists', 0.8);
    let added = 0;
    const processed: LikedTrack[] = [];
    for (const plan of plans) {
        const id = ids.get(plan.playlist);
        if (!id) throw new Error(`playlist « ${plan.playlist} » sans id`);
        for (const slice of chunk(toAdd.get(plan.playlist) ?? [], ADD_CHUNK)) {
            await withRetry('addTracksToPlaylist', () =>
                api.addTracksToPlaylist(
                    id,
                    slice.map((t) => t.uri),
                ),
            );
            added += slice.length;
        }
        processed.push(...plan.tracks);
        set(
            'Ajout aux playlists',
            0.8 + (processed.length / tracks.length) * 0.15,
        );
    }

    let unliked = 0;
    if (job.clear) {
        set('Retrait des likes classés', 0.95);
        for (const slice of chunk(processed, UNLIKE_CHUNK)) {
            await withRetry('removeFromMySavedTracks', () =>
                api.removeFromMySavedTracks(slice.map((t) => t.id)),
            );
            unliked += slice.length;
            set(
                'Retrait des likes classés',
                0.95 + (unliked / processed.length) * 0.05,
            );
        }
    }
    job.summary = {
        liked: tracks.length,
        added,
        duplicates: rows.reduce((s, r) => s + r.duplicates, 0),
        unliked,
        created,
    };
}

// ── Jobs ──────────────────────────────────────────────────────────────────
const jobs = new Map<string, SortJob>();
let current: SortJob | null = null;

export function startSortJob(
    api: SpotifyWebApi,
    mode: 'preview' | 'apply',
    clear: boolean,
): SortJob {
    if (current && current.state === 'running') return current;
    const job: SortJob = {
        id: `${Date.now().toString(36)}-${mode}`,
        mode,
        clear: mode === 'apply' && clear,
        state: 'running',
        startedAt: Date.now(),
        step: 'Démarrage',
        progress: 0,
    };
    jobs.set(job.id, job);
    current = job;
    void runSort(api, job)
        .then(() => {
            job.state = 'done';
            job.progress = 1;
            job.step = 'Terminé';
            Logger.info(
                `likes-sort ${job.mode} terminé : ${JSON.stringify(
                    job.summary,
                )}`,
            );
        })
        .catch((err) => {
            job.state = 'error';
            job.error = describeError(err);
            Logger.error(`likes-sort ${job.mode} : ${job.error}`);
        });
    return job;
}

export function getSortJob(id?: string): SortJob | null {
    if (id) return jobs.get(id) ?? null;
    return current;
}

// ── Tools (app uniquement) ──────────────────────────────────────────────────
const APP_ONLY = { 'x-audience': ['app'] } as const;

const tools: ToolDefinition[] = [
    {
        name: 'likes_sort_start',
        description:
            'Trie les titres likés en playlists par style (règles Yui). mode=preview ne modifie rien ; mode=apply ajoute aux playlists (créées si absentes) et, avec clear, retire des likes ce qui a été classé. Tâche de fond : suivre avec likes_sort_status.',
        inputSchema: {
            type: 'object',
            ...APP_ONLY,
            properties: {
                mode: {
                    type: 'string',
                    enum: ['preview', 'apply'],
                    description: 'preview (aperçu) ou apply (classement)',
                },
                clear: {
                    type: 'boolean',
                    description: 'apply : retirer des likes les titres classés',
                },
            },
            required: ['mode'],
        } as ToolDefinition['inputSchema'],
    },
    {
        name: 'likes_sort_status',
        description:
            'Avancement / résultat du dernier tri des likes (ou du job `id`).',
        inputSchema: {
            type: 'object',
            ...APP_ONLY,
            properties: {
                id: { type: 'string', description: 'Id du job (optionnel)' },
            },
        } as ToolDefinition['inputSchema'],
    },
    {
        name: 'likes_sort_rules',
        description:
            'Règles de tri des likes : playlists cibles et genres associés.',
        inputSchema: {
            type: 'object',
            ...APP_ONLY,
            properties: {},
        } as ToolDefinition['inputSchema'],
    },
];

const handlers: Record<string, ToolHandler> = {
    likes_sort_start: async (args, ctx: ToolContext) => {
        const mode = args.mode === 'apply' ? 'apply' : 'preview';
        const job = startSortJob(ctx.api, mode, args.clear === true);
        return json({
            id: job.id,
            state: job.state,
            mode: job.mode,
            clear: job.clear,
        });
    },
    likes_sort_status: async (args) => {
        const job = getSortJob(
            typeof args.id === 'string' ? args.id : undefined,
        );
        if (!job) return fail('Aucun tri des likes lancé.');
        return json(job);
    },
    likes_sort_rules: async () =>
        json({
            nostalgiaYears: NOSTALGIA_YEARS,
            nostalgiaPlaylist: NOSTALGIA_PLAYLIST,
            unsortedPlaylist: UNSORTED_PLAYLIST,
            rules: RULES,
            playlists: ALL_PLAYLISTS,
        }),
};

export const likesSort: ToolModule = { tools, handlers };
