import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-fx-lib-'));
process.env.YUI_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });

import {
    deleteEffect,
    getEffect,
    listEffects,
    resolveFloating,
    resolveIntro,
    upsertEffect,
    validateEffect,
} from './effectLibrary';

async function run(): Promise<void> {
    // Seeds à la première lecture
    const seeds = listEffects();
    assert.ok(seeds.some((e) => e.id === 'aurora' && e.kind === 'floating'));
    assert.ok(seeds.some((e) => e.id === 'vague-verte' && e.kind === 'intro'));

    // Validation
    assert.ok(validateEffect({ name: 'X', kind: 'floating' }).length > 0);
    assert.deepStrictEqual(
        validateEffect({
            name: 'X',
            kind: 'floating',
            palette: ['#111', '#222'],
            speedSec: 30,
        }),
        [],
    );

    // Upsert : id slug depuis le nom (accents inclus), puis mise à jour
    const created = upsertEffect({
        name: 'Néon Rosé',
        kind: 'floating',
        palette: ['#ff0080', '#8000ff'],
        speedSec: 30,
    });
    assert.strictEqual(created.id, 'neon-rose');
    upsertEffect({ ...created, speedSec: 45 });
    assert.strictEqual(getEffect('neon-rose')!.speedSec, 45);
    assert.strictEqual(
        listEffects().filter((e) => e.id === 'neon-rose').length,
        1,
        'upsert ne duplique pas',
    );

    // resolveFloating : référence → config concrète ; inline passe tel quel
    const cfg = resolveFloating({ effectId: 'neon-rose', target: 'Salon' });
    assert.strictEqual(cfg!.target, 'Salon');
    assert.strictEqual(cfg!.speedSec, 45);
    assert.deepStrictEqual(cfg!.palette, ['#ff0080', '#8000ff']);
    const inline = {
        engine: 'software' as const,
        target: 'Bureau',
        palette: ['#111111', '#222222'],
        speedSec: 10,
    };
    assert.strictEqual(resolveFloating(inline), inline);
    assert.strictEqual(
        resolveFloating({ effectId: 'inexistant', target: 'Salon' }),
        null,
    );

    // resolveIntro : les steps sans cible héritent de la cible d'usage
    const frames = resolveIntro({ effectId: 'vague-verte' }, 'Chambre');
    assert.strictEqual(frames[0].target, 'Chambre');
    const inlineIntro = [
        { type: 'flash' as const, target: 'Salon', colors: ['#ffffff'] },
    ];
    assert.strictEqual(resolveIntro(inlineIntro), inlineIntro);

    // Suppression
    assert.strictEqual(deleteEffect('neon-rose'), true);
    assert.strictEqual(deleteEffect('neon-rose'), false);

    console.log('All effect library tests passed');
}

run()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
