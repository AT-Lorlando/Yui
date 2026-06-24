// packages/mcp-smartthings/src/tools.test.ts
import assert from 'assert';
import { buildSmartThingsTools } from './tools';

async function run() {
    const tools = buildSmartThingsTools(['HDMI3', 'HDMI2', 'dtv']);
    const names = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
        'tv_mute',
        'tv_off',
        'tv_on',
        'tv_set_input',
        'tv_status',
        'tv_volume',
    ]);
    // tv_set_input expose l'enum des entrées
    const setInput = tools.find((t) => t.name === 'tv_set_input')!;
    assert.deepStrictEqual(
        (setInput.inputSchema as any).properties.source.enum,
        ['HDMI3', 'HDMI2', 'dtv'],
    );
    // tv_volume requiert level
    const vol = tools.find((t) => t.name === 'tv_volume')!;
    assert.deepStrictEqual((vol.inputSchema as any).required, ['level']);
    console.log('All mcp-smartthings tools tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
