import assert from 'assert';
import { handleCoversSet, buildCoversSetTool } from './coversSetHandler';

function fakeDeps() {
    const calls: any[] = [];
    return {
        calls,
        deps: {
            listCovers: () => [
                { url: 'u:salon', name: 'Salon' },
                { url: 'u:chambre', name: 'Chambre' },
            ],
            exec: async (url: string, cmd: string, params: unknown[]) => {
                calls.push({ url, cmd, params });
            },
        },
    };
}

async function run(): Promise<void> {
    // all → setClosure sur chaque volet
    {
        const { calls, deps } = fakeDeps();
        await handleCoversSet({ target: 'all', position: 80 }, deps);
        assert.deepStrictEqual(calls, [
            { url: 'u:salon', cmd: 'setClosure', params: [80] },
            { url: 'u:chambre', cmd: 'setClosure', params: [80] },
        ]);
    }
    // nom unique → un seul setClosure
    {
        const { calls, deps } = fakeDeps();
        await handleCoversSet({ target: 'Salon', position: 0 }, deps);
        assert.deepStrictEqual(calls, [
            { url: 'u:salon', cmd: 'setClosure', params: [0] },
        ]);
    }
    // schéma: enum target = all + noms
    {
        const tool = buildCoversSetTool(['Salon', 'Chambre']);
        assert.deepStrictEqual(
            (tool.inputSchema as any).properties.target.enum,
            ['all', 'Salon', 'Chambre'],
        );
        assert.deepStrictEqual((tool.inputSchema as any).required, [
            'target',
            'position',
        ]);
    }
    console.log('All coversSetHandler tests passed');
}

run();
