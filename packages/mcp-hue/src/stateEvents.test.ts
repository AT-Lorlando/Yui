import assert from 'assert';
import {
    idV1ToNumber,
    buildLightIdMap,
    eventsToPatches,
    parseSseChunk,
} from './stateEvents';

const RESOURCES = [
    { id: 'uuid-19', id_v1: '/lights/19' },
    { id: 'uuid-22', id_v1: '/lights/22' },
    { id: 'uuid-room', id_v1: '/groups/3' }, // pas une lampe
    { id: 'uuid-orphan' }, // sans id_v1 (ex: device Zigbee non-lampe)
];

function run(): void {
    assert.strictEqual(idV1ToNumber('/lights/19'), 19);
    assert.strictEqual(idV1ToNumber('/groups/3'), undefined);
    assert.strictEqual(idV1ToNumber(undefined), undefined);

    const idMap = buildLightIdMap(RESOURCES);
    assert.strictEqual(idMap.size, 2, 'seules les lampes sont mappées');
    assert.strictEqual(idMap.get('uuid-19'), 19);

    // Événement d'allumage : `on` seul, pas de dimming
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [{ id: 'uuid-19', type: 'light', on: { on: true } }],
                },
            ],
            idMap,
        );
        assert.deepStrictEqual(patches, [{ id: 19, on: true }]);
        assert.ok(
            !('brightness' in patches[0]),
            'un champ absent de l’event ne doit pas écraser le store',
        );
    }
    // Luminosité seule, arrondie
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [
                        {
                            id: 'uuid-22',
                            type: 'light',
                            dimming: { brightness: 42.6 },
                        },
                    ],
                },
            ],
            idMap,
        );
        assert.deepStrictEqual(patches, [{ id: 22, brightness: 43 }]);
    }
    // Extinction : on=false doit passer (piège du falsy)
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [{ id: 'uuid-19', type: 'light', on: { on: false } }],
                },
            ],
            idMap,
        );
        assert.deepStrictEqual(patches, [{ id: 19, on: false }]);
    }
    // Plusieurs events pour la même lampe dans un lot → fusionnés
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [{ id: 'uuid-19', type: 'light', on: { on: true } }],
                },
                {
                    type: 'update',
                    data: [
                        {
                            id: 'uuid-19',
                            type: 'light',
                            dimming: { brightness: 80 },
                        },
                    ],
                },
            ],
            idMap,
        );
        assert.deepStrictEqual(patches, [{ id: 19, on: true, brightness: 80 }]);
    }
    // Bruit ignoré : boutons, lampes inconnues, events non-update
    {
        const patches = eventsToPatches(
            [
                { type: 'update', data: [{ id: 'x', type: 'button' }] },
                {
                    type: 'update',
                    data: [
                        {
                            id: 'uuid-inconnue',
                            type: 'light',
                            on: { on: true },
                        },
                    ],
                },
                {
                    type: 'delete',
                    data: [{ id: 'uuid-19', type: 'light', on: { on: true } }],
                },
            ],
            idMap,
        );
        assert.deepStrictEqual(patches, []);
    }

    // ── Couleur ──────────────────────────────────────────────────────────
    // Avant : seuls `on` et `dimming` étaient relevés ; la couleur du store
    // restait celle du dernier redémarrage (en prod : 18 scènes sans qu'une
    // seule couleur bouge dans l'app).
    //
    // Changement de couleur : le bridge envoie `color.xy` ET un
    // `color_temperature` invalidé dans le même item.
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [
                        {
                            id: 'uuid-19',
                            type: 'light',
                            color: { xy: { x: 0.64, y: 0.33 } },
                            color_temperature: {
                                mirek: null,
                                mirek_valid: false,
                            },
                        },
                    ],
                },
            ],
            idMap,
        );
        assert.strictEqual(patches.length, 1);
        const p = patches[0];
        assert.strictEqual(p.id, 19);
        assert.ok(
            p.hue !== undefined && (p.hue < 400 || p.hue > 65135),
            `xy rouge → teinte rouge (${p.hue})`,
        );
        assert.ok(p.saturation !== undefined && p.saturation >= 252);
        assert.strictEqual(p.colormode, 'xy');
        assert.ok(!('ct' in p), 'mirek invalide → pas de ct');
        assert.ok(!('on' in p) && !('brightness' in p));
    }
    // Passage en blanc : mirek valide → ct en kelvin, colormode 'ct'. Le xy
    // qui l'accompagne est tout de même relevé (le bridge garde hue/sat).
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [
                        {
                            id: 'uuid-22',
                            type: 'light',
                            color: { xy: { x: 0.4599, y: 0.4106 } },
                            color_temperature: {
                                mirek: 370,
                                mirek_valid: true,
                            },
                        },
                    ],
                },
            ],
            idMap,
        );
        assert.strictEqual(patches.length, 1);
        assert.strictEqual(patches[0].ct, 2703);
        assert.strictEqual(patches[0].colormode, 'ct');
        assert.ok(patches[0].hue !== undefined);
    }
    // mirek seul (lampe blanche réglée depuis l'app Hue)
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [
                        {
                            id: 'uuid-22',
                            type: 'light',
                            color_temperature: {
                                mirek: 153,
                                mirek_valid: true,
                            },
                        },
                    ],
                },
            ],
            idMap,
        );
        assert.deepStrictEqual(patches, [
            { id: 22, ct: 6536, colormode: 'ct' },
        ]);
    }
    // Lot mêlant on + couleur pour la même lampe : tout se cumule.
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [{ id: 'uuid-19', type: 'light', on: { on: true } }],
                },
                {
                    type: 'update',
                    data: [
                        {
                            id: 'uuid-19',
                            type: 'light',
                            color: { xy: { x: 0.15, y: 0.06 } },
                        },
                    ],
                },
            ],
            idMap,
        );
        assert.strictEqual(patches.length, 1);
        assert.strictEqual(patches[0].on, true);
        assert.strictEqual(patches[0].colormode, 'xy');
        assert.ok(
            patches[0].hue !== undefined &&
                patches[0].hue > 42000 &&
                patches[0].hue < 46000,
            'bleu',
        );
    }
    // `color` sans xy (ex. gamut seul) : rien à relever.
    {
        const patches = eventsToPatches(
            [
                {
                    type: 'update',
                    data: [
                        {
                            id: 'uuid-19',
                            type: 'light',
                            color: { gamut_type: 'C' } as any,
                        },
                    ],
                },
            ],
            idMap,
        );
        assert.deepStrictEqual(patches, []);
    }

    // Découpage SSE : trame complète + reliquat conservé
    {
        const chunk =
            'id: 1\ndata: [{"type":"update","data":[{"id":"uuid-19","type":"light","on":{"on":true}}]}]\n\nid: 2\ndata: [{"type":"upda';
        const { events, remainder } = parseSseChunk(chunk);
        assert.strictEqual(events.length, 1);
        assert.ok(
            remainder.startsWith('id: 2'),
            'la trame partielle est gardée',
        );
        assert.deepStrictEqual(eventsToPatches(events, idMap), [
            { id: 19, on: true },
        ]);
    }
    // JSON illisible : ignoré, le flux continue
    {
        const { events } = parseSseChunk('data: {pas du json}\n\n');
        assert.deepStrictEqual(events, []);
    }

    console.log('All stateEvents tests passed');
}

run();
