import assert from 'assert';
import { discoverLights } from './discovery';

// La redécouverte relit le bridge (c'est ce qui dépérime l'état), mais les
// devices non-Hue (Govee) n'existent pas côté bridge : un setAll brut les
// effaçait du store jusqu'au redémarrage.

function fakeStore(initial: any[] = []) {
    let entities = [...initial];
    return {
        getAll: () => entities,
        setAll: (e: any[]) => {
            entities = e;
        },
        saveSnapshot: () => {},
        updateState: () => {},
    } as any;
}

const fakeHue = {
    getAllGroups: async () => [{ name: 'Salon', lights: ['19'] }],
    getAllLights: async () => [
        {
            id: 19,
            name: 'Plafond Salon',
            state: { on: true, bri: 180, hue: 8000, sat: 120, reachable: true },
        },
    ],
} as any;

async function run(): Promise<void> {
    const store = fakeStore([
        // état périmé côté store : la lampe est notée éteinte
        {
            type: 'light',
            id: 19,
            name: 'Plafond Salon',
            room: 'Salon',
            state: { on: false, brightness: 0 },
        },
        {
            type: 'light',
            id: 'g:1',
            name: 'Govee Bas',
            room: 'Salon',
            state: { on: true, brightness: 50 },
        },
    ]);

    await discoverLights(fakeHue, store);
    const all = store.getAll();

    const hue = all.find((l: any) => l.id === 19);
    assert.strictEqual(hue.state.on, true, 'état Hue relu depuis le bridge');
    assert.strictEqual(
        hue.state.brightness,
        71,
        'bri 180/254 converti en pourcentage (le store est en 0–100)',
    );
    assert.strictEqual(hue.room, 'Salon');

    const govee = all.find((l: any) => l.id === 'g:1');
    assert.ok(govee, 'le device Govee doit survivre à la redécouverte');
    assert.strictEqual(govee.name, 'Govee Bas');
    assert.strictEqual(govee.state.on, true, 'son état optimiste est conservé');

    console.log('All discovery tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
