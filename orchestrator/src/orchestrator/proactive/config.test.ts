import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    mergeConfig,
    DEFAULT_CONFIG,
    validateConfig,
    saveConfig,
} from './config';

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

    // ── validateConfig ────────────────────────────────────────────────────────
    assert.deepStrictEqual(
        validateConfig({ enabled: true, chattiness: 'normal' }),
        [],
    );
    assert.ok(validateConfig({ chattiness: 'super-bavard' as any }).length > 0);
    assert.ok(
        validateConfig({ quietHours: { start: '25:00', end: '07:00' } })
            .length > 0,
        'bad time rejected',
    );
    assert.ok(validateConfig({ digestTime: '7h' as any }).length > 0);
    assert.ok(validateConfig({ defaultCooldownMin: -1 }).length > 0);
    assert.ok(validateConfig({ whitelist: 'nope' as any }).length > 0);

    // ── saveConfig: merge onto existing + persist + validate ──────────────────
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-proactive-'));
    const file = path.join(dir, 'proactive.json');
    // seed with extra watcher keys that must be preserved across saves
    fs.writeFileSync(
        file,
        JSON.stringify({ enabled: false, weather: { pollMinutes: 30 } }),
    );

    const saved = saveConfig({ enabled: true, chattiness: 'bavard' }, { file });
    assert.strictEqual(saved.enabled, true);
    assert.strictEqual(saved.chattiness, 'bavard');
    assert.strictEqual(
        (saved as any).weather.pollMinutes,
        30,
        'extra watcher config preserved',
    );
    assert.strictEqual(
        JSON.parse(fs.readFileSync(file, 'utf8')).chattiness,
        'bavard',
    );

    // second save merges onto the previous
    const s2 = saveConfig({ digestTime: '08:00' }, { file });
    assert.strictEqual(s2.chattiness, 'bavard');
    assert.strictEqual(s2.digestTime, '08:00');
    assert.strictEqual((s2 as any).weather.pollMinutes, 30);

    // invalid patch throws, file unchanged
    assert.throws(() => saveConfig({ chattiness: 'x' as any }, { file }));
    assert.strictEqual(
        JSON.parse(fs.readFileSync(file, 'utf8')).chattiness,
        'bavard',
    );

    fs.rmSync(dir, { recursive: true, force: true });

    console.log('All config tests passed');
}

run();
