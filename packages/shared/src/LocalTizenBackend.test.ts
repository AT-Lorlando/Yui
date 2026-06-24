import assert from 'assert';
import { LocalTizenBackend } from './LocalTizenBackend';

async function run() {
    // volumeKeys: 50 VOLDOWN (plancher) puis N VOLUP
    {
        const keys = LocalTizenBackend.volumeKeys(10);
        assert.strictEqual(keys.filter((k) => k === 'KEY_VOLDOWN').length, 50);
        assert.strictEqual(keys.filter((k) => k === 'KEY_VOLUP').length, 10);
    }
    // clamp 0..100
    {
        assert.strictEqual(
            LocalTizenBackend.volumeKeys(250).filter((k) => k === 'KEY_VOLUP')
                .length,
            100,
        );
        assert.strictEqual(
            LocalTizenBackend.volumeKeys(-5).filter((k) => k === 'KEY_VOLUP')
                .length,
            0,
        );
    }
    console.log('All LocalTizenBackend tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
