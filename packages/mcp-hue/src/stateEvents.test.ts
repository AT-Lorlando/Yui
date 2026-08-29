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
