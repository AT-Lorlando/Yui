export interface DeviceLike {
    id?: string | null;
    name?: string | null;
    type?: string | null;
}

/** Résout un nom de haut-parleur vers un device Spotify Connect (exact → partiel → AVR unique). */
export function resolveSpeakerDevice<T extends DeviceLike>(
    devices: T[],
    speakerName: string,
): T | undefined {
    const lower = speakerName.toLowerCase();
    return (
        devices.find((d) => d.name?.toLowerCase() === lower) ??
        devices.find((d) => d.name?.toLowerCase().includes(lower)) ??
        (() => {
            const avrs = devices.filter((d) => d.type === 'AVR');
            return avrs.length === 1 ? avrs[0] : undefined;
        })()
    );
}
