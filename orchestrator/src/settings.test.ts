// orchestrator/src/settings.test.ts
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    settingsFromEnv,
    applyOverlay,
    applyToEnv,
    validateOverlay,
    loadSettings,
    initSettings,
    getSettings,
    updateSettings,
    type Settings,
} from './settings';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'yui-settings-'));
}

function run(): void {
    // ── settingsFromEnv: defaults when env empty ──────────────────────────────
    const def = settingsFromEnv({});
    assert.strictEqual(def.llm.model, 'gpt-4o-mini');
    assert.strictEqual(def.llm.baseUrl, undefined);
    assert.strictEqual(def.tts.speed, 1.0);
    assert.strictEqual(def.logging.level, 'info');
    assert.strictEqual(def.conversation.windowSeconds, 20);
    assert.strictEqual(def.deviceState.refreshMs, 30000);
    assert.strictEqual(def.stories.save, false);
    assert.strictEqual(def.presence.awayTimeoutMin, 15);
    assert.strictEqual(def.presence.arrivalRadiusM, 200);
    assert.strictEqual(def.presence.departureRadiusM, 500);
    assert.strictEqual(def.presence.arrivalScene, null);

    // ── settingsFromEnv: reads + coerces env values ───────────────────────────
    const fromEnv = settingsFromEnv({
        LLM_MODEL: 'deepseek-chat',
        LLM_BASE_URL: 'https://api.deepseek.com',
        XTTS_SPEED: '1.15',
        SAVE_STORIES: 'true',
        LOG_LEVEL: 'debug',
        CONVERSATION_WINDOW_S: '30',
        PRESENCE_ARRIVAL_RADIUS_M: '150',
        PRESENCE_ARRIVAL_SCENE: 'retour-maison',
    });
    assert.strictEqual(fromEnv.llm.model, 'deepseek-chat');
    assert.strictEqual(fromEnv.llm.baseUrl, 'https://api.deepseek.com');
    assert.strictEqual(fromEnv.tts.speed, 1.15);
    assert.strictEqual(fromEnv.stories.save, true);
    assert.strictEqual(fromEnv.logging.level, 'debug');
    assert.strictEqual(fromEnv.conversation.windowSeconds, 30);
    assert.strictEqual(fromEnv.presence.arrivalRadiusM, 150);
    assert.strictEqual(fromEnv.presence.arrivalScene, 'retour-maison');

    // ── applyOverlay: deep merge, overlay wins, siblings preserved ────────────
    const base = settingsFromEnv({});
    const merged = applyOverlay(base, { logging: { level: 'warn' } });
    assert.strictEqual(merged.logging.level, 'warn');
    assert.strictEqual(merged.tts.speed, 1.0); // sibling untouched
    assert.strictEqual(merged.presence.arrivalRadiusM, 200); // sibling untouched
    // base must not be mutated
    assert.strictEqual(base.logging.level, 'info');

    const merged2 = applyOverlay(base, {
        presence: { departureRadiusM: 999 },
    });
    assert.strictEqual(merged2.presence.departureRadiusM, 999);
    assert.strictEqual(merged2.presence.arrivalRadiusM, 200); // nested sibling kept

    // ── validateOverlay ───────────────────────────────────────────────────────
    assert.deepStrictEqual(
        validateOverlay({ logging: { level: 'info' }, tts: { speed: 1.2 } }),
        [],
    );
    assert.ok(
        validateOverlay({ logging: { level: 'verbose-nope' as any } }).length >
            0,
        'bad log level should error',
    );
    assert.ok(
        validateOverlay({ tts: { speed: 0 } }).length > 0,
        'non-positive tts speed should error',
    );
    assert.ok(
        validateOverlay({ presence: { arrivalRadiusM: -5 } }).length > 0,
        'negative radius should error',
    );

    // ── applyToEnv: resolved settings written back into an env object ─────────
    const e: Record<string, string> = {};
    applyToEnv(settingsFromEnv({ XTTS_SPEED: '1.4', SAVE_STORIES: 'true' }), e);
    assert.strictEqual(e.XTTS_SPEED, '1.4');
    assert.strictEqual(e.SAVE_STORIES, 'true');
    assert.strictEqual(e.LOG_LEVEL, 'info');
    assert.strictEqual(e.LLM_MODEL, 'gpt-4o-mini');
    assert.strictEqual(e.PRESENCE_ARRIVAL_RADIUS_M, '200');
    assert.ok(!('LLM_BASE_URL' in e), 'undefined baseUrl must not be written');

    // ── loadSettings: seeds file when missing, then reads it back ─────────────
    const dir = tmpDir();
    const file = path.join(dir, 'settings.json');
    assert.ok(!fs.existsSync(file), 'precondition: no file yet');

    const loaded = loadSettings({ dir, env: { LOG_LEVEL: 'warn' } });
    assert.strictEqual(loaded.logging.level, 'warn'); // env feeds the seed
    assert.ok(fs.existsSync(file), 'loadSettings should seed the file');

    // File on disk overrides env on the next load (precedence json > env).
    const onDisk: Settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    onDisk.logging.level = 'error';
    fs.writeFileSync(file, JSON.stringify(onDisk));
    const reloaded = loadSettings({ dir, env: { LOG_LEVEL: 'warn' } });
    assert.strictEqual(
        reloaded.logging.level,
        'error',
        'file should win over env',
    );

    fs.rmSync(dir, { recursive: true, force: true });

    // ── init + getSettings + updateSettings (cache + persistence) ─────────────
    const dir2 = tmpDir();
    initSettings({ dir: dir2, env: { XTTS_SPEED: '1.3' } });
    assert.strictEqual(getSettings().tts.speed, 1.3);

    const after = updateSettings({ logging: { level: 'debug' } });
    assert.strictEqual(after.logging.level, 'debug');
    assert.strictEqual(getSettings().logging.level, 'debug'); // cache updated
    assert.strictEqual(getSettings().tts.speed, 1.3); // untouched field kept
    const persisted = JSON.parse(
        fs.readFileSync(path.join(dir2, 'settings.json'), 'utf8'),
    );
    assert.strictEqual(persisted.logging.level, 'debug'); // persisted to disk

    assert.throws(
        () => updateSettings({ tts: { speed: -1 } }),
        'invalid patch must throw',
    );

    fs.rmSync(dir2, { recursive: true, force: true });

    console.log('All settings tests passed');
}

run();
