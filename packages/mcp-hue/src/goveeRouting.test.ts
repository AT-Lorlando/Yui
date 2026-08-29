import assert from 'assert';
import {
    isGovee,
    goveeTargetsForRoom,
    goveeTargetsForAll,
} from './goveeRouting';

const LIGHTS = [
    { id: 3, name: 'Hue Salon', room: 'Salon' },
    { id: 'g:1', name: 'Govee Bas', room: 'Salon' },
    { id: 'g:2', name: 'Govee Ambiance', room: 'Salon' },
    { id: 'g:3', name: 'Govee Bureau', room: 'Bureau' },
];
const AMBIANCE = new Set(['g:2']);

const names = (l: { id: string | number }[]) =>
    l.map((x) => LIGHTS.find((y) => y.id === x.id)!.name);

function run(): void {
    assert.strictEqual(isGovee('g:1'), true);
    assert.strictEqual(isGovee(3), false);

    // Pièce allumée / réglée → l'ambiance est ignorée
    assert.deepStrictEqual(
        names(goveeTargetsForRoom(LIGHTS, 'Salon', AMBIANCE, false)),
        ['Govee Bas'],
    );
    // Pièce éteinte → l'ambiance suit
    assert.deepStrictEqual(
        names(goveeTargetsForRoom(LIGHTS, 'Salon', AMBIANCE, true)),
        ['Govee Bas', 'Govee Ambiance'],
    );
    // Casse / espaces insensibles
    assert.strictEqual(
        goveeTargetsForRoom(LIGHTS, ' salon ', AMBIANCE, true).length,
        2,
    );
    // Autre pièce → rien du salon
    assert.deepStrictEqual(
        names(goveeTargetsForRoom(LIGHTS, 'Bureau', AMBIANCE, true)),
        ['Govee Bureau'],
    );
    // Un device ambiance sans pièce n'est ancré nulle part
    assert.deepStrictEqual(
        goveeTargetsForRoom(
            [{ id: 'g:9', room: undefined }],
            'Salon',
            new Set(['g:9']),
            true,
        ),
        [],
    );

    // all-on → ambiance exclue ; all-off → incluse
    assert.deepStrictEqual(names(goveeTargetsForAll(LIGHTS, AMBIANCE, false)), [
        'Govee Bas',
        'Govee Bureau',
    ]);
    assert.deepStrictEqual(names(goveeTargetsForAll(LIGHTS, AMBIANCE, true)), [
        'Govee Bas',
        'Govee Ambiance',
        'Govee Bureau',
    ]);

    console.log('All goveeRouting tests passed');
}

run();
