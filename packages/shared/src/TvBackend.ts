export interface TvStatus {
    power: 'on' | 'off';
    volume?: number;
    muted?: boolean;
    input?: string;
}

export interface TvBackend {
    /** Allume la TV (si besoin) et bascule sur l'entrée Chromecast. */
    ensureOn(): Promise<string>;
    powerOff(): Promise<string>;
    setVolume(level: number): Promise<void>;
    setMute(mute: boolean): Promise<void>;
    setInput(source: string): Promise<void>;
    status(): Promise<TvStatus>;
}
