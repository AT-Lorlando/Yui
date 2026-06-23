import assert from 'assert';
import { TV_INPUT_TOOL, isValidInput } from './tvInputTool';

function run(): void {
    assert.deepStrictEqual(
        (TV_INPUT_TOOL.inputSchema as any).properties.source.enum,
        ['HDMI1', 'HDMI2', 'HDMI3', 'TV', 'AV'],
    );
    assert.deepStrictEqual((TV_INPUT_TOOL.inputSchema as any).required, [
        'source',
    ]);
    assert.strictEqual(isValidInput('HDMI3'), true);
    assert.strictEqual(isValidInput('hdmi9'), false);
    console.log('All tvInput tests passed');
}

run();
