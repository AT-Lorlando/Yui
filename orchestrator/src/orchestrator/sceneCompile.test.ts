import assert from 'assert';
import { compileSimpleScene, type SimpleSceneSpec } from './sceneCompile';

function testCompileState(): void {
    const spec: SimpleSceneSpec = {
        allOff: true,
        lights: [
            { target: 'Salon', on: true, brightness: 30, color: '#FF1744' },
            { target: 'Bureau', on: false },
        ],
        music: { action: 'play', query: 'jazz', speaker: 'Salon' },
        covers: { action: 'close', position: 80, daylightOnly: true },
        door: { action: 'unlock' },
    };

    const { state } = compileSimpleScene(spec);

    assert.deepStrictEqual(state, [
        { tool: '_lights_all_off', args: {} },
        {
            tool: 'set_lights',
            args: {
                target: 'Salon',
                on: true,
                brightness: 30,
                color: '#FF1744',
            },
        },
        { tool: 'set_lights', args: { target: 'Bureau', on: false } },
        { tool: 'play_music', args: { speakerName: 'Salon', query: 'jazz' } },
        {
            tool: '_covers_all',
            args: { action: 'close', position: 80, daylightOnly: true },
        },
        { tool: 'unlock_door', args: {} },
    ]);
}

function testCompileMinimal(): void {
    // pas de allOff, music off, pas de volets/porte
    const spec: SimpleSceneSpec = {
        lights: [{ target: 'Salon', on: true }],
        music: { action: 'off' },
        covers: { action: 'none' },
        door: { action: 'none' },
    };
    const { state } = compileSimpleScene(spec);
    assert.deepStrictEqual(state, [
        { tool: 'set_lights', args: { target: 'Salon', on: true } },
        { tool: 'pause_music', args: {} },
    ]);
}

function testBuildAutoIntro(): void {
    const { buildAutoIntro } = require('./sceneCompile');
    const fx = buildAutoIntro(
        ['#1DB954', '#1E90FF'],
        ['Salon', 'Bureau'],
        'sweep',
        'normal',
    );
    assert.strictEqual(fx.length, 2, 'un effet par couleur');
    assert.deepStrictEqual(fx[0], {
        type: 'sweep',
        target: 'Salon',
        colors: ['#1DB954'],
        startAtMs: 0,
        staggerMs: 120,
        transitionMs: 350,
        holdMs: 100,
    });
    assert.strictEqual(
        fx[1].startAtMs,
        450,
        'chaînage = transitionMs + holdMs précédent',
    );

    // style none → vide
    assert.deepStrictEqual(
        buildAutoIntro(['#fff'], ['Salon'], 'none', 'normal'),
        [],
    );
    // palette vide → vide
    assert.deepStrictEqual(
        buildAutoIntro([], ['Salon'], 'sweep', 'normal'),
        [],
    );
}

function testCompileAmbiance(): void {
    const spec: SimpleSceneSpec = {
        lights: [
            { target: 'Salon', on: true, color: '#1DB954', brightness: 35 },
            { target: 'Bureau', on: true, color: '#1E90FF', brightness: 35 },
        ],
        ambiance: { intro: { style: 'sweep', speed: 'normal' }, motion: true },
    };
    const { intro, floating } = compileSimpleScene(spec);
    assert.ok(intro && intro.length === 2, 'intro générée depuis la palette');
    assert.deepStrictEqual(intro![0].colors, ['#1DB954']);
    assert.ok(floating, 'floating généré');
    assert.deepStrictEqual(floating!.palette, ['#1DB954', '#1E90FF']);
    assert.strictEqual(floating!.target, 'Salon');
    assert.strictEqual(floating!.engine, 'software');

    // pas d'ambiance → ni intro ni floating
    const bare = compileSimpleScene({
        lights: [{ target: 'Salon', on: true }],
    });
    assert.strictEqual(bare.intro, undefined);
    assert.strictEqual(bare.floating, undefined);
}

function testRepresentable(): void {
    const { isSimpleRepresentable } = require('./sceneCompile');

    // représentable : actions connues, pas de setup/condition/$fn
    assert.strictEqual(
        isSimpleRepresentable({
            setup: [],
            state: [
                { tool: 'set_lights', args: { target: 'Salon', on: true } },
                { tool: 'pause_music', args: {} },
            ],
        }),
        true,
    );
    // non : setup non vide
    assert.strictEqual(
        isSimpleRepresentable({
            setup: [{ tool: 'tv_on', args: {} }],
            state: [],
        }),
        false,
    );
    // non : condition présente
    assert.strictEqual(
        isSimpleRepresentable({
            setup: [],
            state: [
                {
                    tool: 'set_lights',
                    args: { target: 'Salon', on: true },
                    condition: { hourBetween: [7, 22] },
                } as any,
            ],
        }),
        false,
    );
    // non : $fn dans les args
    assert.strictEqual(
        isSimpleRepresentable({
            setup: [],
            state: [
                {
                    tool: 'set_lights',
                    args: {
                        target: 'Salon',
                        on: true,
                        brightness: { $fn: 'time_brightness' },
                    },
                },
            ],
        }),
        false,
    );
    // non : tool inconnu (casting)
    assert.strictEqual(
        isSimpleRepresentable({
            setup: [],
            state: [{ tool: 'cast_netflix', args: {} }],
        }),
        false,
    );
    // non : _lights_palette n'est pas représentable par device
    assert.strictEqual(
        isSimpleRepresentable({
            setup: [],
            state: [{ tool: '_lights_palette', args: { colors: ['#fff'] } }],
        }),
        false,
    );
}

function testParseRoundTrip(): void {
    const spec: SimpleSceneSpec = {
        allOff: true,
        lights: [
            { target: 'Salon', on: true, brightness: 30, color: '#FF1744' },
            { target: 'Bureau', on: false },
        ],
        music: { action: 'play', query: 'jazz', speaker: 'Salon' },
        covers: { action: 'close', position: 80, daylightOnly: true },
        door: { action: 'unlock' },
    };
    const { parseToSimpleSpec } = require('./sceneCompile');
    const compiled = compileSimpleScene(spec);
    const parsed = parseToSimpleSpec({ setup: [], state: compiled.state });
    assert.deepStrictEqual(parsed, spec);

    // non représentable → null
    assert.strictEqual(
        parseToSimpleSpec({
            setup: [],
            state: [{ tool: 'cast_netflix', args: {} }],
        }),
        null,
    );
}

function testCompileIfSimple(): void {
    const { compileIfSimple } = require('./sceneCompile');

    // authoring simple → state/intro/floating régénérés, setup vidé
    const out = compileIfSimple({
        name: 'X',
        authoring: 'simple',
        simple: {
            lights: [{ target: 'Salon', on: true, color: '#1DB954' }],
            ambiance: { motion: true },
        },
        setup: [{ tool: 'garbage', args: {} }],
        state: [{ tool: 'stale', args: {} }],
    });
    assert.deepStrictEqual(out.setup, []);
    assert.deepStrictEqual(out.state, [
        {
            tool: 'set_lights',
            args: { target: 'Salon', on: true, color: '#1DB954' },
        },
    ]);
    assert.ok(out.floating, 'floating régénéré');
    assert.strictEqual(out.name, 'X', 'autres champs préservés');

    // authoring advanced → inchangé
    const adv = compileIfSimple({
        authoring: 'advanced',
        setup: [{ tool: 'tv_on', args: {} }],
        state: [{ tool: 'cast_netflix', args: {} }],
    });
    assert.deepStrictEqual(adv.setup, [{ tool: 'tv_on', args: {} }]);
    assert.deepStrictEqual(adv.state, [{ tool: 'cast_netflix', args: {} }]);

    // pas d'authoring → inchangé
    const none = compileIfSimple({ state: [{ tool: 'keep', args: {} }] });
    assert.deepStrictEqual(none.state, [{ tool: 'keep', args: {} }]);
}

function run(): void {
    testCompileState();
    testCompileMinimal();
    testBuildAutoIntro();
    testCompileAmbiance();
    testRepresentable();
    testParseRoundTrip();
    testCompileIfSimple();
    console.log('All sceneCompile tests passed');
}

run();
