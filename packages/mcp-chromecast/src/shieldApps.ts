// Apps du Shield TV : catalogue (packages connus + installés découverts par
// `pm list packages -3`), résolution d'un nom parlé, et l'outil LLM
// `shield_launch`. Pur, testé — l'ADB reste dans ChromecastController.

export interface ShieldApp {
    /** Identifiant court, stable, utilisé par les scènes (`netflix`, `plex`…). */
    id: string;
    label: string;
    package: string;
    /** Autres façons de le dire (voix). */
    aliases?: string[];
}

/** Packages connus → app. Ordre = ordre de présentation. */
export const KNOWN_APPS: ShieldApp[] = [
    { id: 'netflix', label: 'Netflix', package: 'com.netflix.ninja' },
    {
        id: 'youtube',
        label: 'YouTube',
        package: 'com.google.android.youtube.tv',
    },
    {
        id: 'prime',
        label: 'Prime Video',
        package: 'com.amazon.amazonvideo.livingroom',
        aliases: ['amazon', 'prime video', 'amazon prime'],
    },
    {
        id: 'disney',
        label: 'Disney+',
        package: 'com.disney.disneyplus',
        aliases: ['disney plus', 'disney+'],
    },
    {
        id: 'crunchyroll',
        label: 'Crunchyroll',
        package: 'com.crunchyroll.crunchyroid',
    },
    { id: 'plex', label: 'Plex', package: 'com.plexapp.android' },
    { id: 'spotify', label: 'Spotify', package: 'com.spotify.tv.android' },
    {
        id: 'youtube-music',
        label: 'YouTube Music',
        package: 'com.google.android.youtube.tvmusic',
    },
    {
        id: 'amazon-music',
        label: 'Amazon Music',
        package: 'com.amazon.music.tv',
    },
    {
        id: 'google-tv',
        label: 'Google TV (films)',
        package: 'com.google.android.videos',
        aliases: ['play films', 'google play films'],
    },
    {
        id: 'steamlink',
        label: 'Steam Link',
        package: 'com.valvesoftware.steamlink',
        aliases: ['steam'],
    },
    { id: 'moonlight', label: 'Moonlight', package: 'com.limelight' },
    {
        id: 'fully',
        label: 'Fully (dashboard)',
        package: 'de.ozerov.fully',
        aliases: ['dashboard', 'tableau de bord'],
    },
    { id: 'twitch', label: 'Twitch', package: 'tv.twitch.android.app' },
    { id: 'kodi', label: 'Kodi', package: 'org.xbmc.kodi' },
    { id: 'termux', label: 'Termux', package: 'com.termux' },
    {
        id: 'play-games',
        label: 'Play Games',
        package: 'com.google.android.play.games',
    },
];

/** Sortie de `pm list packages` → noms de packages. */
export function parsePackages(out: string): string[] {
    return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('package:'))
        .map((l) => l.slice('package:'.length).trim())
        .filter(Boolean);
}

/**
 * Catalogue proposé : les apps connues installées (ordre connu), puis les
 * autres packages installés sous leur nom brut (id = dernier segment).
 * Sans liste installée (ADB indisponible) → toutes les apps connues.
 */
export function buildCatalog(installed: string[]): ShieldApp[] {
    if (!installed.length) return [...KNOWN_APPS];
    const set = new Set(installed);
    const known = KNOWN_APPS.filter((a) => set.has(a.package));
    const knownPkgs = new Set(known.map((a) => a.package));
    const ids = new Set(known.map((a) => a.id));
    const others: ShieldApp[] = [];
    for (const pkg of installed) {
        if (knownPkgs.has(pkg)) continue;
        if (/^com\.(google|android|nvidia)\.|\.smb$|\.tts$|speech/.test(pkg))
            continue;
        let id = pkg.split('.').pop() ?? pkg;
        for (let n = 2; ids.has(id); n++) id = `${pkg.split('.').pop()}-${n}`;
        ids.add(id);
        others.push({ id, label: id, package: pkg });
    }
    return [...known, ...others];
}

const norm = (s: string) =>
    s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

/** id, package, libellé ou alias (insensible à la casse/accents), puis inclusion. */
export function resolveApp(
    query: string,
    catalog: ShieldApp[],
): ShieldApp | null {
    const q = norm(query);
    if (!q) return null;
    const exact = catalog.find(
        (a) =>
            a.id === query.trim() ||
            a.package === query.trim() ||
            norm(a.label) === q ||
            (a.aliases ?? []).some((x) => norm(x) === q),
    );
    if (exact) return exact;
    const partial = catalog.filter(
        (a) =>
            norm(a.label).includes(q) ||
            a.id.includes(q) ||
            (a.aliases ?? []).some((x) => norm(x).includes(q)),
    );
    return partial.length === 1 ? partial[0] : null;
}

export function shieldLaunchTool(catalog: ShieldApp[]) {
    return {
        name: 'shield_launch',
        description:
            'Ouvre une application sur la TV (Shield) : Netflix, YouTube, Prime Video, Disney+, Crunchyroll, Plex, Spotify, Steam Link, Moonlight, Fully (dashboard)… ' +
            'Pour lancer un contenu précis (un film, une série), utiliser plutôt cast_netflix / cast_prime / cast_youtube… avec le titre.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                app: {
                    type: 'string',
                    title: 'Application',
                    enum: catalog.map((a) => a.id),
                    description: catalog
                        .map((a) => `${a.id} = ${a.label}`)
                        .join(', '),
                },
            },
            required: ['app'],
        },
    };
}
