import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { SpotifyAuth } from './SpotifyAuth';
import { SpotifyController } from './SpotifyController';
import { SPOTIFY_TOOLS } from './tools';
import Logger from './logger';

let spotify: SpotifyController;

const server = new Server(
    { name: 'mcp-spotify', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

type McpContent = { content: Array<{ type: 'text'; text: string }>; isError?: true };

/**
 * Resolve a speaker name to a Spotify Connect device ID, then call playFn.
 * Only works with devices currently active in Spotify Connect.
 */
async function playOnSpeaker(
    speakerName: string | undefined,
    playFn: (deviceId?: string) => Promise<string>,
): Promise<McpContent> {
    if (!speakerName) {
        const description = await playFn(undefined);
        return { content: [{ type: 'text', text: description }] };
    }

    const devices = await spotify.getDevices();
    const device = devices.find(
        (d) => d.name?.toLowerCase() === speakerName.toLowerCase(),
    );

    if (!device?.id) {
        const names = devices.map((d) => d.name).filter(Boolean).join(', ') || 'none';
        return {
            content: [{ type: 'text', text: `Device "${speakerName}" not found or offline. Active Spotify Connect devices: ${names}.` }],
            isError: true,
        };
    }

    await spotify.transferPlayback(device.id);
    const description = await playFn(device.id);
    return { content: [{ type: 'text', text: description }] };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: SPOTIFY_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'list_speakers': {
                const devices = await spotify.getDevices();
                return { content: [{ type: 'text', text: JSON.stringify(devices, null, 2) }] };
            }

            case 'play_music': {
                const speakerName = (args as any)?.speakerName as string | undefined;
                const query = (args as any)?.query as string | undefined;
                const uri = (args as any)?.uri as string | undefined;

                return await playOnSpeaker(speakerName, async (deviceId) => {
                    if (uri) {
                        await spotify.playUri(uri, deviceId);
                        return `Playing ${uri}${speakerName ? ` on ${speakerName}` : ''}.`;
                    }
                    if (query) {
                        const results = await spotify.search(query, 'track');
                        if (results.length === 0) throw new Error(`No tracks found for "${query}".`);
                        const track = results[0];
                        await spotify.playUri(track.uri, deviceId);
                        return `Playing "${track.name}" by ${track.artist}${speakerName ? ` on ${speakerName}` : ''}.`;
                    }
                    await spotify.play(deviceId);
                    return `Playback resumed${speakerName ? ` on ${speakerName}` : ''}.`;
                });
            }

            case 'play_album': {
                const query = String((args as any).query);
                const speakerName = (args as any)?.speakerName as string | undefined;

                return await playOnSpeaker(speakerName, async (deviceId) => {
                    const results = await spotify.search(query, 'album');
                    if (results.length === 0) throw new Error(`No albums found for "${query}".`);
                    const album = results[0];
                    await spotify.playUri(album.uri, deviceId);
                    return `Playing album "${album.name}" by ${album.artist}${speakerName ? ` on ${speakerName}` : ''}.`;
                });
            }

            case 'play_playlist': {
                const query = String((args as any).query);
                const speakerName = (args as any)?.speakerName as string | undefined;

                return await playOnSpeaker(speakerName, async (deviceId) => {
                    const myPlaylists = await spotify.getUserPlaylists();
                    const match = myPlaylists.find(
                        (p) => p.name.toLowerCase().includes(query.toLowerCase()),
                    );

                    if (match) {
                        await spotify.playUri(match.uri, deviceId);
                        return `Playing your playlist "${match.name}"${speakerName ? ` on ${speakerName}` : ''}.`;
                    }

                    const results = await spotify.search(query, 'playlist');
                    if (results.length === 0) throw new Error(`No playlists found for "${query}".`);
                    const playlist = results[0];
                    await spotify.playUri(playlist.uri, deviceId);
                    return `Playing playlist "${playlist.name}" by ${playlist.owner}${speakerName ? ` on ${speakerName}` : ''}.`;
                });
            }

            case 'play_artist_radio': {
                const artist = String((args as any).artist);
                const speakerName = (args as any)?.speakerName as string | undefined;

                return await playOnSpeaker(speakerName, async (deviceId) => {
                    const radio = await spotify.getArtistRadio(artist);
                    if (radio.uri) {
                        await spotify.playUri(radio.uri, deviceId);
                    } else {
                        await spotify.playUris(radio.uris!, deviceId);
                    }
                    return `Playing ${radio.label} for "${radio.artistName}"${speakerName ? ` on ${speakerName}` : ''}.`;
                });
            }

            case 'pause_music': {
                await spotify.pause();
                return { content: [{ type: 'text', text: 'Playback paused.' }] };
            }

            case 'next_track': {
                await spotify.nextTrack();
                return { content: [{ type: 'text', text: 'Skipped to next track.' }] };
            }

            case 'previous_track': {
                await spotify.previousTrack();
                return { content: [{ type: 'text', text: 'Skipped to previous track.' }] };
            }

            case 'set_volume': {
                const percent = Number((args as any).percent);
                await spotify.setVolume(percent);
                return { content: [{ type: 'text', text: `Volume set to ${percent}%.` }] };
            }

            case 'set_shuffle': {
                const enabled = Boolean((args as any).enabled);
                await spotify.setShuffle(enabled);
                return { content: [{ type: 'text', text: `Shuffle ${enabled ? 'enabled' : 'disabled'}.` }] };
            }

            case 'set_repeat': {
                const mode = (args as any).mode as 'off' | 'track' | 'context';
                await spotify.setRepeat(mode);
                const labels = { off: 'off', track: 'repeat current track', context: 'repeat album/playlist' };
                return { content: [{ type: 'text', text: `Repeat set to: ${labels[mode]}.` }] };
            }

            case 'add_to_queue': {
                const query = (args as any)?.query as string | undefined;
                const uri = (args as any)?.uri as string | undefined;

                if (uri) {
                    await spotify.addToQueue(uri);
                    return { content: [{ type: 'text', text: `Added to queue: ${uri}.` }] };
                }
                if (query) {
                    const results = await spotify.search(query, 'track');
                    if (results.length === 0) throw new Error(`No tracks found for "${query}".`);
                    const track = results[0];
                    await spotify.addToQueue(track.uri);
                    return { content: [{ type: 'text', text: `Added to queue: "${track.name}" by ${track.artist}.` }] };
                }
                throw new Error('Provide either query or uri.');
            }

            case 'get_playback_state': {
                const state = await spotify.getPlaybackState();
                return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
            }

            case 'search_music': {
                const query = String((args as any).query);
                const type = ((args as any).type as 'track' | 'album' | 'playlist' | 'artist') || 'track';
                const results = await spotify.search(query, type);
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            }

            case 'get_my_playlists': {
                const playlists = await spotify.getUserPlaylists();
                return { content: [{ type: 'text', text: JSON.stringify(playlists, null, 2) }] };
            }

            case 'refresh_speakers': {
                const devices = await spotify.getDevices();
                return { content: [{ type: 'text', text: `${devices.length} active Spotify Connect device(s): ${devices.map((d) => d.name).join(', ') || 'none'}.` }] };
            }

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    } catch (error) {
        if (error instanceof McpError) throw error;
        Logger.error(`Tool ${name} raw error: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
        const message = error instanceof Error
            ? error.message
            : (error as any)?.error?.message ?? (error as any)?.message ?? JSON.stringify(error);
        Logger.error(`Tool ${name} failed: ${message}`);
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        };
    }
});

async function main() {
    Logger.info('Authenticating with Spotify...');
    const api = await SpotifyAuth.connect();
    spotify = new SpotifyController(api);
    Logger.info('Spotify authenticated.');

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-spotify server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error in mcp-spotify:', err);
    process.exit(1);
});
