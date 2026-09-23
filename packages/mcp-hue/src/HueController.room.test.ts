import assert from 'assert';
import HueController from './HueController';

async function run(): Promise<void> {
    const groupCalls: number[] = [];
    const lightCalls: number[] = [];
    const fakeApi = {
        groups: {
            getAll: async () => [
                { id: 1, type: 'Room', name: 'Chambre', lights: ['21', '23'] },
                { id: 2, type: 'Room', name: 'Salon', lights: ['19'] },
            ],
            setGroupState: async (id: number) => void groupCalls.push(id),
        },
        lights: {
            getLight: async (id: number) => ({ id, name: 'L', state: {} }),
            setLightState: async (id: number) => void lightCalls.push(id),
        },
    };
    const ctl = new HueController(fakeApi as any);
    await ctl.initCache();

    // Pièce exacte (casse indifférente) → groupe.
    await ctl.setRoomLights('chambre', { on: true });
    assert.deepStrictEqual(groupCalls, [1]);
    // Partiel plus court → groupe (« chamb »).
    await ctl.setRoomLights('Chamb', { on: true });
    assert.deepStrictEqual(groupCalls, [1, 1]);
    // Un NOM DE LAMPE contenant le nom de la pièce n'est PAS la pièce.
    await assert.rejects(
        () => ctl.setRoomLights('Plafond Chambre', { on: true }),
        /introuvable/,
    );
    await assert.rejects(
        () => ctl.setRoomLights('Plafond Salon', { on: true }),
        /introuvable/,
    );
    assert.deepStrictEqual(groupCalls, [1, 1], 'aucun groupe touché');
    console.log('All HueController room tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
