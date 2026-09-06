export interface DeviceLike {
    id?: string | null;
    name?: string | null;
    type?: string | null;
}

/**
 * Résout un nom de haut-parleur vers un device Spotify Connect
 * (exact → partiel → AVR unique si `avrFallback`).
 *
 * Le repli AVR existe pour la WiiM, qui s'annonce parfois sous un nom hashé
 * dans Connect — mais il ne doit jouer QUE pour l'enceinte par défaut :
 * appliqué à n'importe quel nom, il capturait « Google Home » et la musique
 * partait sur la Sono au lieu de la chambre (et le réveil Cast ne courait
 * jamais, puisque la résolution « réussissait »).
 */
export function resolveSpeakerDevice<T extends DeviceLike>(
    devices: T[],
    speakerName: string,
    opts: { avrFallback?: boolean } = {},
): T | undefined {
    const lower = speakerName.toLowerCase();
    return (
        devices.find((d) => d.name?.toLowerCase() === lower) ??
        devices.find((d) => d.name?.toLowerCase().includes(lower)) ??
        (() => {
            if (!opts.avrFallback) return undefined;
            const avrs = devices.filter((d) => d.type === 'AVR');
            return avrs.length === 1 ? avrs[0] : undefined;
        })()
    );
}
