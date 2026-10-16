import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// dataPath() est résolu au chargement du module : poser YUI_DATA_DIR avant.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-amp-'));
fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
fs.writeFileSync(
    path.join(dir, 'config', 'broadlink-codes.json'),
    JSON.stringify({ marantz_amp: { power_toggle: 'deadbeef' } }),
);
process.env.YUI_DATA_DIR = dir;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AmpController } = require('./AmpController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SPOTIFY_TOOLS } = require('./tools');

const stateFile = path.join(dir, 'state', 'amp-state.json');
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf-8'));

async function run() {
    const amp = new AmpController('10.0.0.1');
    let irSent = 0;
    (amp as any).sendCode = async () => {
        irSent++;
    };
    (amp as any).connect = async () => {
        throw new Error('connect must not be called');
    };

    const t0 = Date.now();
    assert.strictEqual(await amp.forceState('on'), 'on');
    assert.deepStrictEqual(readState(), { marantz_amp: 'on' });
    assert.strictEqual(await amp.forceState('off'), 'off');
    assert.deepStrictEqual(readState(), { marantz_amp: 'off' });
    assert.strictEqual(irSent, 0, 'forceState must never send IR');
    assert.ok(Date.now() - t0 < 1000, 'no settle delay');

    // Sérialisé avec les toggles : un forceState posté après ensureOn passe
    // APRÈS lui (l'état final est celui du forceState).
    const on = amp.ensureOn();
    const forced = amp.forceState('off');
    await Promise.all([on, forced]);
    assert.strictEqual(irSent, 1);
    assert.deepStrictEqual(readState(), { marantz_amp: 'off' });

    // Schéma du tool.
    const tool = SPOTIFY_TOOLS.find((t: any) => t.name === 'amp_set_state');
    assert.ok(tool, 'amp_set_state declared');
    assert.deepStrictEqual(tool.inputSchema['x-audience'], ['app']);
    assert.deepStrictEqual(tool.inputSchema.properties.state.enum, [
        'on',
        'off',
    ]);
    assert.deepStrictEqual(tool.inputSchema.required, ['state']);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('All AmpController.forceState tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
