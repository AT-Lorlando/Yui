import assert from 'assert';
import { handleCastApp, CAST_APP_TOOL } from './castAppHandler';

function fakeCaster() {
    const calls: any[] = [];
    return {
        calls,
        caster: {
            netflix: async (t?: string) => {
                calls.push({ app: 'netflix', t });
                return 'ok';
            },
            youtube: async (t?: string) => {
                calls.push({ app: 'youtube', t });
                return 'ok';
            },
            crunchyroll: async (t?: string) => {
                calls.push({ app: 'crunchyroll', t });
                return 'ok';
            },
            disney: async (t?: string) => {
                calls.push({ app: 'disney', t });
                return 'ok';
            },
            prime: async (t?: string) => {
                calls.push({ app: 'prime', t });
                return 'ok';
            },
        },
    };
}

async function run(): Promise<void> {
    {
        const { calls, caster } = fakeCaster();
        await handleCastApp({ app: 'netflix', title: 'Dune' }, caster);
        assert.deepStrictEqual(calls, [{ app: 'netflix', t: 'Dune' }]);
    }
    {
        const { calls, caster } = fakeCaster();
        await handleCastApp({ app: 'youtube' }, caster);
        assert.deepStrictEqual(calls, [{ app: 'youtube', t: undefined }]);
    }
    // remaining apps dispatch to the correct caster fn
    for (const app of ['crunchyroll', 'disney', 'prime'] as const) {
        const { calls, caster } = fakeCaster();
        await handleCastApp({ app, title: 'X' }, caster);
        assert.deepStrictEqual(calls, [{ app, t: 'X' }]);
    }
    // app inconnue → throw
    {
        const { caster } = fakeCaster();
        await assert.rejects(() => handleCastApp({ app: 'vlc' }, caster));
    }
    // schéma
    assert.deepStrictEqual(
        (CAST_APP_TOOL.inputSchema as any).properties.app.enum,
        ['netflix', 'youtube', 'crunchyroll', 'disney', 'prime'],
    );
    console.log('All castAppHandler tests passed');
}

run();
