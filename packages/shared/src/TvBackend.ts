export interface TvStatus {
    power: 'on' | 'off';
    volume?: number;
    muted?: boolean;
    input?: string;
    /** Entrées annoncées par la TV (mediaInputSource.supportedInputSources). */
    supportedInputs?: string[];
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
