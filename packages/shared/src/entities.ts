export interface BaseEntity {
    id: string | number;
    name: string;
    room?: string;
    lastDiscovered: string;
}

export interface LightEntity extends BaseEntity {
    type: 'light';
    state: {
        on: boolean;
        brightness: number;
        hue?: number; // 0–65535 (champ v1 du bridge)
        saturation?: number; // 0–254 (HSV)
        ct?: number; // blanc en kelvin — le bridge parle mirek, l'app kelvin
        colormode?: 'hs' | 'xy' | 'ct';
        reachable: boolean;
    };
}

export interface DoorEntity extends BaseEntity {
    type: 'door';
    deviceType: number;
    state: {
        stateName: string;
        batteryCritical: boolean;
        doorState?: string;
    };
}

export interface SpeakerEntity extends BaseEntity {
    type: 'speaker';
    host: string;
    port: number;
    deviceModel?: string;
    spotifyDeviceId?: string;
    state: {
        reachable: boolean;
    };
}

export interface EntitySnapshot<T extends BaseEntity> {
    serverName: string;
    discoveredAt: string;
    entityCount: number;
    entities: T[];
}
