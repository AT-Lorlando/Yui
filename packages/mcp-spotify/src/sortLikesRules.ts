/**
 * Pure classification rules for `npm run sort-likes` (no network, unit-tested
 * in sortLikesRules.test.ts).
 *
 * A liked track goes to:
 *   1. "Nostalgie" when it was liked more than NOSTALGIA_YEARS ago;
 *   2. otherwise the FIRST rule of RULES whose genre set intersects the
 *      track's genres (the union of its artists' Spotify genres);
 *   3. otherwise UNSORTED_PLAYLIST ("À trier"), sorted by hand later.
 *
 * Genres are compared lower-cased and trimmed. Order matters: a genre must
 * appear in at most one rule (asserted by the test suite) — put the more
 * specific playlist first when a genre could belong to several.
 */

export interface SortRule {
    playlist: string;
    genres: string[];
}

export const NOSTALGIA_YEARS = 5;
export const NOSTALGIA_PLAYLIST = 'Nostalgie';
export const UNSORTED_PLAYLIST = 'À trier';

export const RULES: SortRule[] = [
    {
        playlist: 'Anime, BO & Gaming',
        genres: [
            'anime',
            'j-pop',
            'j-rock',
            'vocaloid',
            'score',
            'soundtrack',
            'medieval',
            'city pop',
            'video game music',
        ],
    },
    {
        playlist: 'Phonk & Dark',
        genres: ['phonk', 'drift phonk', 'brazilian phonk', 'witch house'],
    },
    {
        playlist: 'Drum & Bass',
        genres: ['drum and bass', 'liquid funk', 'jungle'],
    },
    {
        playlist: 'Rap FR',
        genres: ['french rap', 'pop urbaine', 'french r&b', 'shatta'],
    },
    {
        playlist: 'Rap international',
        genres: [
            'uk drill',
            'uk grime',
            'grime',
            'rap',
            'trap',
            'hip hop',
            'east coast hip hop',
            'emo rap',
            'melodic rap',
            'german hip hop',
            'afroswing',
            'west coast hip hop',
        ],
    },
    {
        playlist: 'Hardstyle & Hardcore',
        genres: [
            'hardstyle',
            'frenchcore',
            'gabber',
            'hardcore',
            'hardcore techno',
            'speedcore',
            'rawstyle',
            'uptempo hardcore',
        ],
    },
    {
        playlist: 'Trance & Psytrance',
        genres: ['psytrance', 'trance', 'progressive trance', 'goa trance'],
    },
    {
        playlist: 'Techno & Hypertechno',
        genres: [
            'hard techno',
            'hypertechno',
            'techno',
            'tekno',
            'minimal techno',
            'acid techno',
            'nightcore',
        ],
    },
    {
        playlist: 'Pop & Chanson FR',
        genres: [
            'french pop',
            'chanson',
            'variété française',
            'french indie pop',
        ],
    },
    {
        playlist: 'Rock & Alternatif',
        genres: [
            'rock',
            'alternative rock',
            'indie',
            'neo-psychedelic',
            'emo',
            'pop punk',
            'nu metal',
            'alternative metal',
            'finnish rock',
            'indie folk',
            'metal',
            'metalcore',
        ],
    },
    {
        playlist: 'Chill, Soul & Groove',
        genres: [
            'soul',
            'funk',
            'g-funk',
            'disco',
            'post-disco',
            'jazz',
            'jazz house',
            'lounge',
            'dub',
            'downtempo',
            'trip hop',
            'dark r&b',
            'yacht rock',
            'indie soul',
            'electro swing',
            'nu jazz',
            'neoclassical',
            'space music',
            'freestyle',
            'italo disco',
            'r&b',
            'ambient',
            'ambient jazz',
            'blues',
        ],
    },
    {
        playlist: 'Melodic & Stutter House',
        genres: [
            'stutter house',
            'melodic house',
            'melodic techno',
            'progressive house',
            'organic house',
        ],
    },
    {
        playlist: 'Électro & French Touch',
        genres: [
            'french house',
            'electro',
            'electronic',
            'synthwave',
            'chillwave',
            'vaporwave',
            'electroclash',
            'new rave',
        ],
    },
    {
        playlist: 'Dance & EDM',
        genres: [
            'house',
            'deep house',
            'afro house',
            'tech house',
            'tropical house',
            'slap house',
            'edm',
            'future house',
            'future bass',
            'nu disco',
            'disco house',
            'funky house',
            'electro house',
            'moombahton',
            'eurodance',
            'big room',
            'melbourne bounce',
            'brazilian bass',
            'latin house',
            'edm trap',
            'alternative dance',
            'rally house',
            'bass house',
            'g-house',
            'afro tech',
            'kuduro',
            'dance pop',
            'dancehall',
            'afrobeats',
        ],
    },
    {
        // "dance pop" is claimed by Dance & EDM above (first match wins).
        playlist: 'Pop internationale',
        genres: [
            'pop',
            'art pop',
            'norwegian pop',
            'k-pop',
            'latin pop',
            'indie pop',
        ],
    },
];

/** Every playlist name the sorter may write to, in rule order. */
export const ALL_PLAYLISTS: string[] = [
    NOSTALGIA_PLAYLIST,
    ...RULES.map((r) => r.playlist),
    UNSORTED_PLAYLIST,
];

export interface ClassifiableTrack {
    /** ISO date the track was liked (`added_at`). */
    addedAt: string | Date;
    /** Union of the artists' genres (any case). */
    genres: Iterable<string>;
}

const normalise = (g: string): string => g.trim().toLowerCase();

/** `d` moved back `years` years (calendar arithmetic, keeps day/time). */
export function yearsBefore(d: Date, years: number): Date {
    const out = new Date(d.getTime());
    out.setUTCFullYear(out.getUTCFullYear() - years);
    return out;
}

/** True when `addedAt` is strictly older than `now - NOSTALGIA_YEARS`. */
export function isNostalgic(addedAt: string | Date, now: Date): boolean {
    const added = addedAt instanceof Date ? addedAt : new Date(addedAt);
    if (Number.isNaN(added.getTime())) return false;
    return added.getTime() < yearsBefore(now, NOSTALGIA_YEARS).getTime();
}

/** First rule whose genres intersect `genres`, or undefined. */
export function matchRule(genres: Iterable<string>): SortRule | undefined {
    const set = new Set<string>();
    for (const g of genres) set.add(normalise(g));
    if (set.size === 0) return undefined;
    return RULES.find((rule) => rule.genres.some((g) => set.has(normalise(g))));
}

/** Target playlist name for a liked track. */
export function classifyTrack(
    track: ClassifiableTrack,
    now: Date = new Date(),
): string {
    if (isNostalgic(track.addedAt, now)) return NOSTALGIA_PLAYLIST;
    return matchRule(track.genres)?.playlist ?? UNSORTED_PLAYLIST;
}

/**
 * Genres listed in more than one rule (would be ambiguous — the first rule
 * silently wins). Empty when the table is sound; asserted by the tests.
 */
export function duplicateGenres(
    rules: readonly SortRule[] = RULES,
): Map<string, string[]> {
    const owners = new Map<string, string[]>();
    for (const rule of rules) {
        for (const g of new Set(rule.genres.map(normalise))) {
            owners.set(g, [...(owners.get(g) ?? []), rule.playlist]);
        }
    }
    return new Map([...owners].filter(([, playlists]) => playlists.length > 1));
}
