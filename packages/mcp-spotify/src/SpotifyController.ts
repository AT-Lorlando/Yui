import SpotifyWebApi from 'spotify-web-api-node';
import Logger from './logger';

export class SpotifyController {
    constructor(private api: SpotifyWebApi) {}

    getAccessToken(): string {
        const token = this.api.getAccessToken();
        if (!token) throw new Error('No Spotify access token available');
        return token;
    }

    async play(deviceId?: string): Promise<void> {
        await this.api.play(deviceId ? { device_id: deviceId } : undefined);
        Logger.debug('Playback resumed');
    }

    /**
     * Play a Spotify URI.
     * - track: plays within its album context so music continues after the track
     * - album / playlist / artist: played as context_uri
     */
    async playUri(uri: string, deviceId?: string): Promise<void> {
        const options: Parameters<SpotifyWebApi['play']>[0] = {};
        if (deviceId) options.device_id = deviceId;

        if (uri.includes(':track:')) {
            // Try to get the track's album so playback continues past the track
            try {
                const trackId = uri.split(':track:')[1];
                const trackRes = await this.api.getTrack(trackId);
                const albumUri = trackRes.body.album.uri;
                options.context_uri = albumUri;
                options.offset = { uri };
            } catch {
                // Fallback to single-track if API fails
                options.uris = [uri];
            }
        } else {
            options.context_uri = uri;
        }

        await this.api.play(options);
        Logger.debug(`Playing URI: ${uri}`);
    }

    /** Play an ordered list of track URIs (e.g. radio recommendations) */
    async playUris(uris: string[], deviceId?: string): Promise<void> {
        if (uris.length === 0) throw new Error('No URIs to play');
        const options: Parameters<SpotifyWebApi['play']>[0] = { uris };
        if (deviceId) options.device_id = deviceId;
        await this.api.play(options);
        Logger.debug(`Playing ${uris.length} URIs`);
    }

    async pause(): Promise<void> {
        await this.api.pause();
        Logger.debug('Playback paused');
    }

    async nextTrack(): Promise<void> {
        await this.api.skipToNext();
        Logger.debug('Skipped to next track');
    }

    async previousTrack(): Promise<void> {
        await this.api.skipToPrevious();
        Logger.debug('Skipped to previous track');
    }

    async setVolume(percent: number): Promise<void> {
        const vol = Math.max(0, Math.min(100, Math.round(percent)));
        await this.api.setVolume(vol);
        Logger.debug(`Volume set to ${vol}%`);
    }

    async setShuffle(state: boolean): Promise<void> {
        await this.api.setShuffle(state);
        Logger.debug(`Shuffle set to ${state}`);
    }

    async setRepeat(mode: 'off' | 'track' | 'context'): Promise<void> {
        await this.api.setRepeat(mode);
        Logger.debug(`Repeat set to ${mode}`);
    }

    async seekTo(positionMs: number): Promise<void> {
        await this.api.seek(positionMs);
        Logger.debug(`Seeked to ${positionMs}ms`);
    }

    async addToQueue(uri: string): Promise<void> {
        await this.api.addToQueue(uri);
        Logger.debug(`Added to queue: ${uri}`);
    }

    /** Search tracks, albums, playlists, or artists */
    async search(
        query: string,
        type: 'track' | 'album' | 'playlist' | 'artist' = 'track',
    ): Promise<any[]> {
        const result = await this.api.search(query, [type], { limit: 10 });
        const body = result.body;

        if (type === 'track' && body.tracks) {
            return body.tracks.items.filter(Boolean).map((t) => ({
                name: t.name,
                artist: t.artists.map((a) => a.name).join(', '),
                album: t.album.name,
                uri: t.uri,
                albumUri: t.album.uri,
            }));
        }
        if (type === 'album' && body.albums) {
            return body.albums.items.filter(Boolean).map((a) => ({
                name: a.name,
                artist: a.artists.map((ar) => ar.name).join(', '),
                uri: a.uri,
                totalTracks: a.total_tracks,
            }));
        }
        if (type === 'playlist' && body.playlists) {
            return body.playlists.items.filter(Boolean).map((p) => ({
                name: p!.name,
                owner: p!.owner.display_name,
                uri: p!.uri,
                tracks: (p as any).tracks?.total,
            }));
        }
        if (type === 'artist' && body.artists) {
            return body.artists.items.filter(Boolean).map((a) => ({
                name: a.name,
                uri: a.uri,
                id: a.id,
                genres: a.genres?.slice(0, 3),
            }));
        }
        return [];
    }

    /** Get the user's saved playlists */
    async getUserPlaylists(limit = 50): Promise<any[]> {
        const result = await this.api.getUserPlaylists({ limit });
        return result.body.items.filter(Boolean).map((p) => ({
            name: p!.name,
            owner: p!.owner.display_name,
            uri: p!.uri,
            tracks: p!.tracks.total,
        }));
    }

    /**
     * Get an artist radio / mix.
     * Strategy: look for a "This Is {artist}" or "{artist} Radio" Spotify-curated playlist,
     * then fall back to the artist's top tracks.
     * Returns a context URI (playlist) or track URIs.
     */
    async getArtistRadio(
        artistName: string,
    ): Promise<{ uri?: string; uris?: string[]; label: string; artistName: string }> {
        // Find the artist
        const artists = await this.search(artistName, 'artist');
        if (artists.length === 0) throw new Error(`Artist "${artistName}" not found on Spotify`);
        const artist = artists[0];

        // Try "This Is {artist}" (Spotify's curated essential playlist)
        const thisIs = await this.search(`This Is ${artist.name}`, 'playlist');
        const thisIsMatch = thisIs.find(
            (p) =>
                p.name.toLowerCase().includes('this is') &&
                p.name.toLowerCase().includes(artist.name.toLowerCase()),
        );
        if (thisIsMatch) {
            Logger.debug(`Artist radio for "${artist.name}": using "This Is" playlist`);
            return { uri: thisIsMatch.uri, label: `"${thisIsMatch.name}" playlist`, artistName: artist.name };
        }

        // Try "{artist} Radio" playlist
        const radioSearch = await this.search(`${artist.name} Radio`, 'playlist');
        const radioMatch = radioSearch.find(
            (p) => p.name.toLowerCase().includes(artist.name.toLowerCase()),
        );
        if (radioMatch) {
            Logger.debug(`Artist radio for "${artist.name}": using radio playlist`);
            return { uri: radioMatch.uri, label: `"${radioMatch.name}" playlist`, artistName: artist.name };
        }

        // Fall back to artist top tracks
        const topRes = await this.api.getArtistTopTracks(artist.id, 'FR');
        const uris = topRes.body.tracks.map((t) => t.uri);
        Logger.debug(`Artist radio for "${artist.name}": using ${uris.length} top tracks`);
        return { uris, label: `top tracks`, artistName: artist.name };
    }

    async getPlaybackState(): Promise<any> {
        const result = await this.api.getMyCurrentPlaybackState();
        const state = result.body;

        if (!state || !state.item) {
            return { playing: false };
        }

        const item = state.item as SpotifyApi.TrackObjectFull;

        return {
            playing: state.is_playing,
            track: item.name,
            artist: item.artists?.map((a) => a.name).join(', '),
            album: (item as any).album?.name,
            progress_ms: state.progress_ms,
            duration_ms: item.duration_ms,
            shuffle: state.shuffle_state,
            repeat: state.repeat_state,
            device: state.device
                ? {
                      name: state.device.name,
                      type: state.device.type,
                      volume: state.device.volume_percent,
                  }
                : undefined,
        };
    }

    async getDevices(): Promise<SpotifyApi.UserDevice[]> {
        const result = await this.api.getMyDevices();
        return result.body.devices;
    }

    async transferPlayback(deviceId: string): Promise<void> {
        await this.api.transferMyPlayback([deviceId]);
        Logger.debug(`Playback transferred to device ${deviceId}`);
    }
}
