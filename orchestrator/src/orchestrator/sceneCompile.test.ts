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

function run(): void {
    testCompileState();
    testCompileMinimal();
    console.log('All sceneCompile tests passed');
}

run();
