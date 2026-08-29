import assert from 'assert';
import { migrateLegacyActions } from './legacyActions';

// Les cas testés reprennent les usages RÉELS du scenes.json de prod (checkout
// koya) — c'est lui que le shim doit garder fonctionnel sans réécriture.
function run(): void {
    // light_set nominal (prod : scène f2a3745e)
    assert.deepStrictEqual(
        migrateLegacyActions([
            {
                tool: 'light_set',
                args: {
                    target: 'TV Droite',
                    on: true,
                    color: '#ff0000',
                    brightness: 100,
                },
            },
        ]),
        [
            {
                tool: 'set_lights',
                args: {
                    target: 'TV Droite',
                    on: true,
                    color: '#ff0000',
                    brightness: 100,
                },
            },
        ],
    );

    // lights_palette_set ciblé (prod : scène a9c36318) — $fn préservé
    assert.deepStrictEqual(
        migrateLegacyActions([
            {
                tool: 'lights_palette_set',
                args: {
                    target: 'Salon',
                    colors: ['#ffffff'],
                    brightness: { $fn: 'time_brightness' },
                },
            },
        ]),
        [
            {
                tool: 'set_room_palette',
                args: {
                    room: 'Salon',
                    colors: ['#ffffff'],
                    brightness: { $fn: 'time_brightness' },
                },
            },
        ],
    );

    // light_set 'all' → tools globaux
    assert.deepStrictEqual(
        migrateLegacyActions([
            { tool: 'light_set', args: { target: 'all', on: false } },
        ]),
        [{ tool: 'turn_off_all_lights', args: {} }],
    );
    assert.deepStrictEqual(
        migrateLegacyActions([
            { tool: 'light_set', args: { target: 'all', brightness: 40 } },
        ]),
        [{ tool: 'turn_on_all_lights', args: { brightness: 40 } }],
    );

    // lights_palette_set 'all' → _lights_palette
    assert.deepStrictEqual(
        migrateLegacyActions([
            {
                tool: 'lights_palette_set',
                args: { target: 'all', colors: ['#111'] },
            },
        ]),
        [{ tool: '_lights_palette', args: { colors: ['#111'] } }],
    );

    // music_play → play_music (speaker → speakerName)
    assert.deepStrictEqual(
        migrateLegacyActions([
            { tool: 'music_play', args: { query: 'lofi', speaker: 'Salon' } },
        ]),
        [
            {
                tool: 'play_music',
                args: { query: 'lofi', speakerName: 'Salon' },
            },
        ],
    );

    // covers_set → set_cover_position
    assert.deepStrictEqual(
        migrateLegacyActions([
            { tool: 'covers_set', args: { target: 'Terrasse', position: 80 } },
        ]),
        [
            {
                tool: 'set_cover_position',
                args: { device: 'Terrasse', position: 80 },
            },
        ],
    );

    // Récursif dans les branches _if, delayMs/condition préservés
    const migrated = migrateLegacyActions([
        {
            tool: '_if',
            args: {
                condition: { device: 'lights', is: 'off' },
                then: [
                    {
                        tool: 'light_set',
                        args: { target: 'Salon', on: true },
                        delayMs: 500,
                    },
                ],
                else: [],
            },
        },
    ]);
    const then = (migrated[0].args as any).then;
    assert.strictEqual(then[0].tool, 'set_lights');
    assert.strictEqual(then[0].delayMs, 500);

    // Les actions modernes passent inchangées
    const modern = [
        { tool: 'set_lights', args: { target: 'Salon', on: true } },
        { tool: 'scene_trigger', args: { id: 'lofi' } },
    ];
    assert.deepStrictEqual(migrateLegacyActions(modern), modern);

    console.log('All legacyActions tests passed');
}

run();
