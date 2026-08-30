import assert from 'assert';
import { resolveTargetIds, coveredIds, othersToTurnOff } from './bulkStates';

const LIGHTS = [
    { id: 16, name: 'TV Droite', room: 'Salon' },
    { id: 17, name: 'TV Gauche', room: 'Salon' },
    { id: 19, name: 'Plafond Salon', room: 'Salon' },
    { id: 21, name: 'Plafond Chambre', room: 'Chambre' },
    { id: 'g:1', name: 'Govee Bas', room: 'Salon' },
    { id: 'g:2', name: 'Govee Ambiance', room: 'Salon' },
];
// g:1 et g:2 = même lampe physique (H60B0, deux canaux logiques).
const GOVEE_IPS = new Map([
    ['g:1', '10.0.0.199'],
    ['g:2', '10.0.0.199'],
]);

function run(): void {
    // Pièce → toutes ses lampes ; lampe → elle seule ; casse insensible
    assert.deepStrictEqual(resolveTargetIds(LIGHTS, 'Chambre'), [21]);
    assert.deepStrictEqual(resolveTargetIds(LIGHTS, 'tv droite'), [16]);
    assert.deepStrictEqual(resolveTargetIds(LIGHTS, 'Garage'), []);

    // Le cas Mentalist : deux lampes TV listées, tout le reste s'éteint
    const covered = coveredIds(LIGHTS, [
        { target: 'TV Droite', on: true, color: '#ff0000' },
        { target: 'TV Gauche', on: true, color: '#0000ff' },
    ]);
    assert.deepStrictEqual([...covered], [16, 17]);
    const off = othersToTurnOff(LIGHTS, covered, GOVEE_IPS);
    assert.deepStrictEqual(off.hueIds, [19, 21]);
    assert.deepStrictEqual(
        off.goveeIds,
        ['g:1'],
        'g:1 et g:2 partagent une IP — un seul off suffit (dédup à l’envoi)',
    );

    // Garde matériel partagé : la scène allume Govee Ambiance → NE PAS éteindre
    // Govee Bas (même lampe physique, l’off couperait tout)
    const covered2 = coveredIds(LIGHTS, [
        { target: 'Govee Ambiance', on: true, color: '#FF1744' },
    ]);
    const off2 = othersToTurnOff(LIGHTS, covered2, GOVEE_IPS);
    assert.deepStrictEqual(off2.hueIds, [16, 17, 19, 21]);
    assert.deepStrictEqual(
        off2.goveeIds,
        [],
        'aucun Govee éteint quand un canal de la même lampe est couvert',
    );

    // Une pièce couverte protège toutes ses lampes du othersOff
    const covered3 = coveredIds(LIGHTS, [{ target: 'Salon', on: true }]);
    const off3 = othersToTurnOff(LIGHTS, covered3, GOVEE_IPS);
    assert.deepStrictEqual(off3.hueIds, [21]);
    assert.deepStrictEqual(off3.goveeIds, []);

    console.log('All bulkStates tests passed');
}

run();
