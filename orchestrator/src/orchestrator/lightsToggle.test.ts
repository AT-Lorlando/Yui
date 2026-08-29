import assert from 'assert';
import { runVirtualAction } from './scenes';

// _lights_toggle lit l'état réel de la cible et l'inverse.

function harness(lights: any[]) {
    const executed: { tool: string; args: any }[] = [];
    const callTool = async (name: string, args: Record<string, unknown>) => {
        if (name === 'list_lights') return lights;
        executed.push({ tool: name, args });
        return null;
    };
    return { executed, callTool: callTool as any };
}

async function run(): Promise<void> {
    // Pièce allumée → extinction
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: true } }]);
        await runVirtualAction(
            { tool: '_lights_toggle', args: { target: 'Salon' } },
            h.callTool,
            {},
        );
        assert.deepStrictEqual(h.executed, [
            { tool: 'set_lights', args: { target: 'Salon', on: false } },
        ]);
    }
    // Pièce éteinte → allumage, avec les options passées
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: false } }]);
        await runVirtualAction(
            {
                tool: '_lights_toggle',
                args: { target: 'Salon', brightness: 40, color: '#FF8800' },
            },
            h.callTool,
            {},
        );
        assert.deepStrictEqual(h.executed, [
            {
                tool: 'set_lights',
                args: {
                    target: 'Salon',
                    on: true,
                    brightness: 40,
                    color: '#FF8800',
                },
            },
        ]);
    }
    // brightness/color ignorés quand on éteint
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: true } }]);
        await runVirtualAction(
            {
                tool: '_lights_toggle',
                args: { target: 'Salon', brightness: 40 },
            },
            h.callTool,
            {},
        );
        assert.deepStrictEqual(h.executed[0].args, {
            target: 'Salon',
            on: false,
        });
    }
    // Sans cible → bascule de tout l'appartement
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: false } }]);
        await runVirtualAction(
            { tool: '_lights_toggle', args: { brightness: 70 } },
            h.callTool,
            {},
        );
        assert.deepStrictEqual(h.executed, [
            { tool: 'turn_on_all_lights', args: { brightness: 70 } },
        ]);
    }
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: true } }]);
        await runVirtualAction(
            { tool: '_lights_toggle', args: {} },
            h.callTool,
            {},
        );
        assert.deepStrictEqual(h.executed, [
            { tool: 'turn_off_all_lights', args: {} },
        ]);
    }
    // Cible inconnue → état 'unknown', donc allumage (jamais d'extinction à l'aveugle)
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: true } }]);
        await runVirtualAction(
            { tool: '_lights_toggle', args: { target: 'Garage' } },
            h.callTool,
            {},
        );
        assert.strictEqual(h.executed[0].args.on, true);
    }

    console.log('All _lights_toggle tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
