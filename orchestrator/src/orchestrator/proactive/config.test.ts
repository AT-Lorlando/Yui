import assert from 'assert';
import { mergeConfig, DEFAULT_CONFIG } from './config';

function run(): void {
    // défauts conservés quand le fichier est partiel
    const merged = mergeConfig({ enabled: true, chattiness: 'bavard' });
    assert.strictEqual(merged.enabled, true);
    assert.strictEqual(merged.chattiness, 'bavard');
    assert.strictEqual(merged.digestTime, DEFAULT_CONFIG.digestTime);
    assert.deepStrictEqual(merged.whitelist, []);

    // entrée invalide → défauts sûrs (désactivé)
    const safe = mergeConfig(null);
    assert.strictEqual(safe.enabled, false);

    console.log('All config tests passed');
}

run();
