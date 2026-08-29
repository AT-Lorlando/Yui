import assert from 'assert';
import { runActions, multiPressWindow } from './hueRemotes';

// Un binding de télécommande doit se comporter comme une scène : les
// conditions par action sont évaluées, et sur l'état lu au DÉBUT de l'appui
// (sinon la première action fausserait la condition de la seconde).

function harness(initialLights: any[]) {
    const lights = initialLights.map((l) => ({ ...l, state: { ...l.state } }));
    const executed: { tool: string; args: any }[] = [];
    const callTool = async (name: string, args: Record<string, unknown>) => {
        if (name === 'list_lights') return lights;
        executed.push({ tool: name, args });
        // Simule l'effet réel : allumer/éteindre la pièce ciblée.
        if (name === 'set_lights') {
            for (const l of lights) {
                if (l.room === args.target) l.state.on = args.on !== false;
            }
        }
        return null;
    };
    return { executed, lights, deps: { callTool } };
}

const TOGGLE_BINDING = [
    {
        tool: 'set_lights',
        args: { target: 'Salon', on: false },
        condition: { device: 'lights' as const, target: 'Salon', is: 'on' },
    },
    {
        tool: 'set_lights',
        args: { target: 'Salon', on: true, brightness: 60 },
        condition: { device: 'lights' as const, target: 'Salon', is: 'off' },
    },
];

async function run(): Promise<void> {
    // Salon allumé → seule l'extinction part
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: true } }]);
        await runActions(TOGGLE_BINDING, h.deps as any);
        assert.deepStrictEqual(
            h.executed.map((e) => e.args.on),
            [false],
            'seule la branche "éteindre" doit partir',
        );
    }
    // Salon éteint → seul l'allumage part
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: false } }]);
        await runActions(TOGGLE_BINDING, h.deps as any);
        assert.deepStrictEqual(
            h.executed.map((e) => e.args.on),
            [true],
            'seule la branche "allumer" doit partir',
        );
        assert.strictEqual(h.executed[0].args.brightness, 60);
    }
    // Une pièce non ciblée n'influence pas la décision
    {
        const h = harness([
            { name: 'A', room: 'Salon', state: { on: false } },
            { name: 'B', room: 'Chambre', state: { on: true } },
        ]);
        await runActions(TOGGLE_BINDING, h.deps as any);
        assert.deepStrictEqual(
            h.executed.map((e) => e.args.on),
            [true],
            'la Chambre allumée ne doit pas empêcher le Salon de s’allumer',
        );
    }
    // Sans condition, tout part (comportement historique préservé)
    {
        const h = harness([{ name: 'A', room: 'Salon', state: { on: true } }]);
        await runActions(
            [{ tool: 'scene_trigger', args: { id: 'lofi' } }],
            h.deps as any,
        );
        assert.strictEqual(h.executed.length, 1);
    }
    // Condition de présence
    {
        const h = harness([]);
        await runActions(
            [
                {
                    tool: 'lock_door',
                    args: {},
                    condition: { presence: 'away' as const },
                },
            ],
            { ...h.deps, presenceState: () => 'home' } as any,
        );
        assert.strictEqual(h.executed.length, 0, 'présent → action ignorée');
        await runActions(
            [
                {
                    tool: 'lock_door',
                    args: {},
                    condition: { presence: 'away' as const },
                },
            ],
            { ...h.deps, presenceState: () => 'away' } as any,
        );
        assert.strictEqual(h.executed.length, 1, 'absent → action exécutée');
    }

    // Fenêtre multi-appui : 0 (immédiat) sauf si un binding 2×/3× existe.
    assert.strictEqual(multiPressWindow(undefined), 0);
    assert.strictEqual(multiPressWindow({}), 0);
    assert.strictEqual(
        multiPressWindow({ shortPress: { '1': [{ tool: 'x' }] } }),
        0,
        'un seul binding simple → pas de debounce',
    );
    assert.strictEqual(
        multiPressWindow({
            shortPress: { '1': [{ tool: 'x' }], '2': [{ tool: 'y' }] },
        }),
        400,
        'double-appui configuré → fenêtre de détection nécessaire',
    );

    console.log('All hueRemotes condition tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
