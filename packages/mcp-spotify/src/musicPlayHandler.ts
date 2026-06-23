export interface MusicPlayDevice {
    id?: string | null;
    name?: string | null;
}

export interface MusicPlayDeps {
    defaultSpeaker: string;
    getDevices: () => Promise<MusicPlayDevice[]>;
    resolveSpeaker: (
        devices: MusicPlayDevice[],
        name: string,
    ) => MusicPlayDevice | undefined;
    transfer: (deviceId: string) => Promise<unknown>;
    search: (
        query: string,
        type?: string,
    ) => Promise<{ uri: string; name: string; artist: string }[]>;
    playUri: (uri: string, deviceId?: string) => Promise<unknown>;
    play: (deviceId?: string) => Promise<unknown>;
}

export function buildMusicPlayTool(speakerNames: string[] = []) {
    const speaker: Record<string, unknown> = {
        type: 'string',
        description: 'Haut-parleur cible (défaut: WiiM).',
    };
    if (speakerNames.length) speaker.enum = speakerNames;
    return {
        name: 'music_play',
        description: 'Lance de la musique (recherche) sur un haut-parleur.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description: 'Recherche : titre, ambiance, playlist.',
                },
                speaker,
            },
        },
    };
}

export async function handleMusicPlay(
    args: Record<string, unknown>,
    deps: MusicPlayDeps,
): Promise<string> {
    const query = args.query !== undefined ? String(args.query) : undefined;
    const speakerName =
        args.speaker !== undefined ? String(args.speaker) : deps.defaultSpeaker;

    const devices = await deps.getDevices();
    const device = deps.resolveSpeaker(devices, speakerName);
    const deviceId = device?.id ?? undefined;
    if (deviceId) await deps.transfer(deviceId);

    if (query) {
        const results = await deps.search(query, 'track');
        if (!results.length) throw new Error(`Aucun résultat pour "${query}".`);
        await deps.playUri(results[0].uri, deviceId);
        return `Lecture de "${results[0].name}" — ${results[0].artist}.`;
    }
    await deps.play(deviceId);
    return 'Lecture reprise.';
}
