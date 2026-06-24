// packages/shared/src/smartThingsConfig.test.ts
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function run() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cfg-'));
    process.env.YUI_DATA_DIR = tmp;
    // import APRÈS avoir fixé YUI_DATA_DIR (dataPath lit l'env au runtime)
    const { loadTvConfig, saveSmartThingsCreds, loadSmartThingsCreds } =
        await import('./smartThingsConfig.js');

    // loadTvConfig → défauts quand le fichier est absent
    {
        const cfg = loadTvConfig();
        assert.strictEqual(cfg.chromecastInput, 'HDMI3');
        assert.strictEqual(cfg.inputs.HDMI3, 'Chromecast');
        assert.ok(cfg.mac.length > 0);
    }
    // loadSmartThingsCreds → throw quand absent
    {
        assert.throws(() => loadSmartThingsCreds(), /setup:smartthings/);
    }
    // save puis load round-trip
    {
        saveSmartThingsCreds({
            clientId: 'cid',
            clientSecret: 'sec',
            refreshToken: 'rt',
            deviceId: 'dev',
        });
        const c = loadSmartThingsCreds();
        assert.strictEqual(c.refreshToken, 'rt');
        assert.strictEqual(c.deviceId, 'dev');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('All smartThingsConfig tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
