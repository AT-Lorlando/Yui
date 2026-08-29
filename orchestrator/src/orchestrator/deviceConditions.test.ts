import assert from 'assert';
import {
    readDeviceState,
    createStateReader,
    readAllDeviceStates,
} from './deviceConditions';

const LIGHTS = [
    { id: 19, name: 'Plafond Salon', room: 'Salon', state: { on: false } },
    { id: 22, name: 'Hue Go', room: 'Salon', state: { on: true } },
    { id: 23, name: 'Chevet', room: 'Chambre', state: { on: false } },
];

function fakeCallTool(lights: unknown[] = LIGHTS) {
    const calls: string[] = [];
    const callTool = async (name: string) => {
        calls.push(name);
        if (name === 'list_lights') return lights;
        return null;
    };
    return { calls, callTool: callTool as any };
}

async function run(): Promise<void> {
    // Sans cible : au moins une lampe allumée dans l'appartement
    {
        const { callTool } = fakeCallTool();
        assert.strictEqual(await readDeviceState('lights', callTool), 'on');
    }
    // Cible = pièce
    {
        const { callTool } = fakeCallTool();
        assert.strictEqual(
            await readDeviceState('lights', callTool, 'Salon'),
            'on',
            'Salon a une lampe allumée',
        );
        assert.strictEqual(
            await readDeviceState('lights', callTool, 'Chambre'),
            'off',
            'Chambre tout éteint',
        );
        assert.strictEqual(
            await readDeviceState('lights', callTool, 'salon'),
            'on',
            'casse insensible',
        );
    }
    // Cible = lampe précise (et non sa pièce)
    {
        const { callTool } = fakeCallTool();
        assert.strictEqual(
            await readDeviceState('lights', callTool, 'Plafond Salon'),
            'off',
            'la lampe est éteinte même si sa pièce a une lampe allumée',
        );
        assert.strictEqual(
            await readDeviceState('lights', callTool, 'Hue Go'),
            'on',
        );
    }
    // Cible inconnue → 'unknown', surtout pas 'off'
    {
        const { callTool } = fakeCallTool();
        assert.strictEqual(
            await readDeviceState('lights', callTool, 'Garage'),
            'unknown',
        );
    }
    // 'all' explicite = tout l'appartement
    {
        const { callTool } = fakeCallTool();
        assert.strictEqual(
            await readDeviceState('lights', callTool, 'all'),
            'on',
        );
    }
    // Liste vide → unknown (bridge injoignable, pas "tout éteint")
    {
        const { callTool } = fakeCallTool([]);
        assert.strictEqual(
            await readDeviceState('lights', callTool, 'Salon'),
            'unknown',
        );
    }

    // Le cache du reader distingue les cibles
    {
        const { calls, callTool } = fakeCallTool();
        const read = createStateReader(callTool);
        const [a, b, c] = await Promise.all([
            read('lights', 'Salon'),
            read('lights', 'Chambre'),
            read('lights', 'Salon'),
        ]);
        assert.deepStrictEqual([a, b, c], ['on', 'off', 'on']);
        assert.strictEqual(
            calls.filter((n) => n === 'list_lights').length,
            2,
            'une lecture par cible distincte, Salon mis en cache',
        );
    }

    // Snapshot pour l'app : une entrée par pièce et par lampe
    {
        const { callTool } = fakeCallTool();
        const all = await readAllDeviceStates(callTool);
        assert.strictEqual(all['lights'], 'on');
        assert.strictEqual(all['lights:Salon'], 'on');
        assert.strictEqual(all['lights:Chambre'], 'off');
        assert.strictEqual(all['lights:Plafond Salon'], 'off');
    }

    console.log('All deviceConditions tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
