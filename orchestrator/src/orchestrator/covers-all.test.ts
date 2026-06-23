import assert from 'assert';
import { runVirtualAction } from './scenes';

async function run(): Promise<void> {
    // close sans garde jour → set_cover_position appelé par volet à la position donnée
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const callTool = async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        if (tool === 'list_covers') {
            return [{ name: 'Salon' }, { name: 'Chambre' }];
        }
        return null;
    };

    await runVirtualAction(
        {
            tool: '_covers_all',
            args: { action: 'close', position: 80, daylightOnly: false },
        },
        callTool,
        {},
    );

    const sets = calls.filter((c) => c.tool === 'set_cover_position');
    assert.strictEqual(sets.length, 2, 'un set_cover_position par volet');
    assert.deepStrictEqual(sets[0].args, { device: 'Salon', position: 80 });
    assert.deepStrictEqual(sets[1].args, { device: 'Chambre', position: 80 });

    // open sans position → position 0 par défaut
    const calls2: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const callTool2 = async (tool: string, args: Record<string, unknown>) => {
        calls2.push({ tool, args });
        if (tool === 'list_covers') return [{ name: 'Salon' }];
        return null;
    };
    await runVirtualAction(
        { tool: '_covers_all', args: { action: 'open' } },
        callTool2,
        {},
    );
    const sets2 = calls2.filter((c) => c.tool === 'set_cover_position');
    assert.strictEqual(sets2.length, 1);
    assert.deepStrictEqual(sets2[0].args, { device: 'Salon', position: 0 });

    console.log('All covers-all tests passed');
}

run();
