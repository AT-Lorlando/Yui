import assert from 'assert';
import {
    handleLightSet,
    handleLightsPaletteSet,
    buildLightSetTools,
} from './lightSetHandlers';

function fakeDeps() {
    const calls: any[] = [];
    return {
        calls,
        deps: {
            getRoomNames: () => ['Salon', 'Bureau'],
            setRoomLights: async (room: string, opts: any) => {
                calls.push({ fn: 'room', room, opts });
            },
            setRoomPalette: async (
                room: string,
                colors: string[],
                brightness?: number,
            ) => {
                calls.push({ fn: 'palette', room, colors, brightness });
            },
            findLightByName: (name: string) =>
                name === 'Lampe X' ? { id: 7, name: 'Lampe X' } : undefined,
            setLight: async (id: number, opts: any) => {
                calls.push({ fn: 'light', id, opts });
            },
        },
    };
}

async function run(): Promise<void> {
    // target "all" → setRoomLights pour chaque pièce
    {
        const { calls, deps } = fakeDeps();
        await handleLightSet(
            { target: 'all', on: true, brightness: 40, color: '#FF0000' },
            deps,
        );
        const rooms = calls.filter((c) => c.fn === 'room').map((c) => c.room);
        assert.deepStrictEqual(rooms, ['Salon', 'Bureau']);
        assert.deepStrictEqual(calls[0].opts, {
            on: true,
            brightness: 40,
            color: '#FF0000',
        });
    }
    // target = pièce → setRoomLights(room)
    {
        const { calls, deps } = fakeDeps();
        await handleLightSet({ target: 'Salon', brightness: 20 }, deps);
        assert.deepStrictEqual(calls, [
            { fn: 'room', room: 'Salon', opts: { on: true, brightness: 20 } },
        ]);
    }
    // target = lampe nommée → setLight(id)
    {
        const { calls, deps } = fakeDeps();
        await handleLightSet({ target: 'Lampe X', color: '#00FF00' }, deps);
        assert.deepStrictEqual(calls, [
            { fn: 'light', id: 7, opts: { on: true, color: '#00FF00' } },
        ]);
    }
    // palette: all → setRoomPalette par pièce
    {
        const { calls, deps } = fakeDeps();
        await handleLightsPaletteSet(
            { target: 'all', colors: ['#111', '#222'], brightness: 30 },
            deps,
        );
        assert.deepStrictEqual(
            calls.map((c) => c.room),
            ['Salon', 'Bureau'],
        );
        assert.deepStrictEqual(calls[0], {
            fn: 'palette',
            room: 'Salon',
            colors: ['#111', '#222'],
            brightness: 30,
        });
    }
    // schéma: enum target inclut all + pièces + lampes ; x-dynamic + x-widget présents
    {
        const tools = buildLightSetTools(['Salon'], ['Lampe X']);
        const ls = tools.find((t: any) => t.name === 'light_set')!;
        assert.deepStrictEqual((ls.inputSchema as any).properties.target.enum, [
            'all',
            'Salon',
            'Lampe X',
        ]);
        assert.deepStrictEqual(
            (ls.inputSchema as any).properties.brightness['x-dynamic'],
            ['time_brightness', 'random'],
        );
        assert.strictEqual(
            (ls.inputSchema as any).properties.color['x-widget'],
            'color',
        );
        const lp = tools.find((t: any) => t.name === 'lights_palette_set')!;
        assert.deepStrictEqual((lp.inputSchema as any).properties.target.enum, [
            'all',
            'Salon',
        ]); // rooms only, no 'Lampe X'
        assert.strictEqual(
            (lp.inputSchema as any).properties.colors.items['x-widget'],
            'color',
        );
    }
    console.log('All lightSetHandlers tests passed');
}

run();
