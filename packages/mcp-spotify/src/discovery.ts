import Bonjour from 'bonjour-service';
import type { EntityStore, SpeakerEntity } from '@yui/shared';
import type { SpotifyController } from './SpotifyController';
import Logger from './logger';

export async function discoverSpeakers(
    spotify: SpotifyController,
    store: EntityStore<SpeakerEntity>,
): Promise<void> {
    const bonjourDevices = await scanBonjour();

    let spotifyDevices: SpotifyApi.UserDevice[] = [];
    try {
        spotifyDevices = await spotify.getDevices();
        Logger.debug(
            `Spotify Connect devices: ${spotifyDevices.map((d) => d.name).join(', ')}`,
        );
    } catch (error) {
        Logger.warn(`Could not fetch Spotify devices: ${error}`);
    }

    // Preserve previously matched Spotify device IDs (they're persistent)
    const previousEntities = store.getAll();
    const previousIds = new Map(
        previousEntities
            .filter((e) => e.spotifyDeviceId)
            .map((e) => [e.name.toLowerCase(), e.spotifyDeviceId]),
    );

    const now = new Date().toISOString();
    const entities: SpeakerEntity[] = bonjourDevices.map((device) => {
        const matched = spotifyDevices.find(
            (sd) =>
                sd.name?.toLowerCase() === device.name.toLowerCase(),
        );

        const spotifyDeviceId =
            matched?.id ??
            previousIds.get(device.name.toLowerCase()) ??
            undefined;

        return {
            type: 'speaker' as const,
            id: device.name,
            name: device.name,
            host: device.host,
            port: device.port,
            deviceModel: device.model,
            spotifyDeviceId,
            lastDiscovered: now,
            state: {
                reachable: true,
            },
        };
    });

    // Keep previously known speakers that didn't respond to Bonjour (marked unreachable)
    const bonjourNames = new Set(entities.map((e) => e.name.toLowerCase()));
    for (const prev of previousEntities) {
        if (!bonjourNames.has(prev.name.toLowerCase())) {
            entities.push({
                ...prev,
                state: { reachable: false },
            });
            Logger.debug(`Keeping previously known speaker "${prev.name}" (unreachable)`);
        }
    }

    store.setAll(entities);
    store.saveSnapshot();
    Logger.info(
        `Speaker discovery complete: ${entities.length} speaker(s) cached ` +
            `(${entities.filter((e) => e.spotifyDeviceId).length} matched to Spotify, ` +
            `${entities.filter((e) => !e.state.reachable).length} unreachable)`,
    );
}

interface BonjourDevice {
    name: string;
    host: string;
    port: number;
    model?: string;
}

function scanBonjour(): Promise<BonjourDevice[]> {
    return new Promise((resolve) => {
        const instance = new Bonjour();
        const devices: BonjourDevice[] = [];

        const browser = instance.find({ type: 'googlecast' });

        browser.on('up', (service) => {
            const friendlyName =
                service.txt?.fn || service.name || 'Unknown';
            const model = service.txt?.md;

            if (
                !devices.some(
                    (d) =>
                        d.name === friendlyName &&
                        d.host === service.host,
                )
            ) {
                devices.push({
                    name: friendlyName,
                    host: service.host ?? '',
                    port: service.port,
                    model,
                });
                Logger.debug(
                    `Bonjour: found ${friendlyName} (${model ?? 'unknown'}) at ${service.host}:${service.port}`,
                );
            }
        });

        setTimeout(() => {
            browser.stop();
            instance.destroy();
            resolve(devices);
        }, 10000);
    });
}
