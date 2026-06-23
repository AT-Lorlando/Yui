import assert from 'assert';
import { annotateHidden } from './toolsHidden';

function run(): void {
    const tools = [
        {
            serverName: 'mcp-hue',
            name: 'light_set',
            description: 'd',
            inputSchema: {},
        },
        {
            serverName: 'mcp-hue',
            name: 'set_lights',
            description: 'd',
            inputSchema: {},
        },
    ];
    const hidden = new Set(['light_set']);
    const out = annotateHidden(tools, hidden);
    assert.strictEqual(out[0].hidden, true, 'light_set caché');
    assert.strictEqual(out[1].hidden, false, 'set_lights visible');
    // n'altère pas les autres champs
    assert.strictEqual(out[0].name, 'light_set');
    console.log('All getTools-hidden tests passed');
}

run();
