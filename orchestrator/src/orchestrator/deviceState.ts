// Formateurs purs du snapshot d'état injecté dans le system prompt.
// Chacun reçoit le retour déjà parsé de l'outil de lecture MCP correspondant
// et renvoie une ligne compacte en français, ou null si rien d'exploitable.

function briToPercent(bri: unknown): number | undefined {
    if (typeof bri !== 'number') return undefined;
    return Math.round((bri / 254) * 100);
}

export function formatLights(raw: unknown): string | null {
    if (!Array.isArray(raw)) return null;
    const entries = raw
        .filter((l: any) => l && l.state)
        .map((l: any) => {
            const label = l.name ?? l.room ?? '?';
            if (l.state.reachable === false) return `${label} injoignable`;
            if (l.state.on !== true) return `${label} éteint`;
            const pct = briToPercent(l.state.brightness);
            return pct !== undefined
                ? `${label} allumé (${pct}%)`
                : `${label} allumé`;
        });
    return entries.length ? `Lumières : ${entries.join(', ')}` : null;
}

export function formatDoors(raw: unknown): string | null {
    if (!Array.isArray(raw)) return null;
    const entries = raw
        .filter((d: any) => d && d.state)
        .map((d: any) => {
            const label = d.name ?? '?';
            const s = d.state.stateName ?? 'inconnu';
            const fr =
                s === 'locked'
                    ? 'verrouillée'
                    : s === 'unlocked'
                    ? 'déverrouillée'
                    : s;
            return `${label} ${fr}`;
        });
    return entries.length ? `Serrures : ${entries.join(', ')}` : null;
}

export function formatPlayback(raw: unknown): string | null {
    const s = raw as any;
    if (!s || typeof s !== 'object') return null;
    if (s.playing !== true) return 'Lecture : rien en cours';
    const track = s.track ?? '?';
    const artist = s.artist ? ` — ${s.artist}` : '';
    const vol =
        typeof s.device?.volume === 'number' ? ` (vol ${s.device.volume})` : '';
    const dev = s.device?.name ? ` sur ${s.device.name}` : '';
    return `Lecture : « ${track} »${artist}${vol}${dev}`;
}

export function formatTv(raw: unknown): string | null {
    const s = raw as any;
    if (!s || typeof s !== 'object' || s.power === undefined) return null;
    return s.power === 'on' ? 'TV : allumée' : 'TV : éteinte';
}

export function formatCovers(raw: unknown): string | null {
    if (!Array.isArray(raw)) return null;
    const entries = raw
        .filter((c: any) => c && c.name)
        .map((c: any) => {
            const label = c.name;
            if (typeof c.position !== 'number')
                return `${label} (position inconnue)`;
            if (c.position <= 0) return `${label} ouvert`;
            if (c.position >= 100) return `${label} fermé`;
            return `${label} ${c.position}% fermé`;
        });
    return entries.length ? `Volets : ${entries.join(', ')}` : null;
}

export function buildDeviceStateSnapshot(parts: Array<string | null>): string {
    return parts.filter((p): p is string => Boolean(p)).join('\n');
}
