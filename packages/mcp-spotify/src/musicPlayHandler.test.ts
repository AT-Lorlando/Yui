import assert from 'assert';
import { handleMusicPlay, buildMusicPlayTool } from './musicPlayHandler';

function fakeDeps() {
    const calls: any[] = [];
    return {
        calls,
        deps: {
            defaultSpeaker: 'WiiM',
            getDevices: async () => [
                { id: 'd1', name: 'WiiM' },
                { id: 'd2', name: 'Salon' },
            ],
            resolveSpeaker: (devices: any[], name: string) =>
                devices.find((d) => d.name === name),
            transfer: async (id: string) => {
                calls.push({ fn: 'transfer', id });
            },
            search: async (q: string) => {
                calls.push({ fn: 'search', q });
                return [{ uri: 'spotify:track:1', name: 'T', artist: 'A' }];
            },
            playUri: async (uri: string, id?: string) => {
                calls.push({ fn: 'playUri', uri, id });
            },
            play: async (id?: string) => {
                calls.push({ fn: 'play', id });
            },
        },
    };
}

async function run(): Promise<void> {
    // query + speaker → transfert puis recherche+lecture sur le bon device
    {
        const { calls, deps } = fakeDeps();
        await handleMusicPlay({ query: 'lofi', speaker: 'Salon' }, deps);
        assert.deepStrictEqual(calls[0], { fn: 'transfer', id: 'd2' });
        assert.deepStrictEqual(calls[1], { fn: 'search', q: 'lofi' });
        assert.deepStrictEqual(calls[2], {
            fn: 'playUri',
            uri: 'spotify:track:1',
            id: 'd2',
        });
    }
    // sans speaker → device par défaut résolu
    {
        const { calls, deps } = fakeDeps();
        await handleMusicPlay({ query: 'jazz' }, deps);
        assert.deepStrictEqual(calls[0], { fn: 'transfer', id: 'd1' });
    }
    // sans query → reprise lecture
    {
        const { calls, deps } = fakeDeps();
        await handleMusicPlay({}, deps);
        assert.ok(calls.some((c) => c.fn === 'play'));
    }
    // schéma: speaker enum
    {
        const tool = buildMusicPlayTool(['WiiM', 'Salon']);
        assert.deepStrictEqual(
            (tool.inputSchema as any).properties.speaker.enum,
            ['WiiM', 'Salon'],
        );
    }
    // schéma: pas d'enum quand speakerNames vide
    {
        const tool = buildMusicPlayTool([]);
        assert.ok(!('enum' in (tool.inputSchema as any).properties.speaker));
    }
    console.log('All musicPlayHandler tests passed');
}

run();
