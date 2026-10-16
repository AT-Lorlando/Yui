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
    mergeFloatingEffects,
    resolveFloating,
    type LightEffect,
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

    // mergeFloatingEffects : union des cibles, premier effet, perTarget
    const lib: Record<string, LightEffect> = {
        a: {
            id: 'a',
            name: 'A',
            kind: 'floating',
            palette: ['#aa0000', '#aa1111'],
            speedSec: 30,
            staggerSec: 4,
            speedJitter: 0.2,
            brightness: 50,
            createdAt: 0,
        },
        b: {
            id: 'b',
            name: 'B',
            kind: 'floating',
            palette: ['#0000bb', '#1111bb'],
            createdAt: 0,
        },
        i: { id: 'i', name: 'I', kind: 'intro', steps: [], createdAt: 0 },
    };
    const look = (id: string) => lib[id];
    const merged = mergeFloatingEffects(
        [
            { effectId: 'a', target: 'Salon' },
            { effectId: 'b', target: ['Lampe Sol', 'salon'] },
            { effectId: 'b', target: 'Bureau' },
        ],
        look,
    )!;
    assert.deepStrictEqual(merged.target, ['Salon', 'Lampe Sol', 'Bureau']);
    assert.deepStrictEqual(merged.palette, ['#aa0000', '#aa1111']);
    assert.strictEqual(merged.speedSec, 30);
    assert.strictEqual(merged.staggerSec, 4);
    assert.strictEqual(merged.speedJitter, 0.2);
    assert.strictEqual(merged.brightness, 50);
    assert.strictEqual(merged.engine, 'software');
    // Cible répétée : la dernière entrée gagne (salon → b)
    assert.deepStrictEqual(merged.perTarget, {
        salon: { palette: ['#0000bb', '#1111bb'], speedSec: 60 },
        'lampe sol': { palette: ['#0000bb', '#1111bb'], speedSec: 60 },
        bureau: { palette: ['#0000bb', '#1111bb'], speedSec: 60 },
    });
    // Effet manquant / intro ignorés ; une seule cible string reste string
    const single = mergeFloatingEffects(
        [
            { effectId: 'zz', target: 'Cuisine' },
            { effectId: 'i', target: 'Chambre' },
            { effectId: 'b', target: 'Salon' },
        ],
        look,
    )!;
    assert.strictEqual(single.target, 'Salon');
    assert.strictEqual(single.speedSec, 60);
    assert.deepStrictEqual(single.perTarget, {
        salon: { palette: ['#0000bb', '#1111bb'], speedSec: 60 },
    });
    assert.strictEqual(
        mergeFloatingEffects([{ effectId: 'zz', target: 'X' }], look),
        null,
    );
    assert.strictEqual(mergeFloatingEffects([], look), null);
    // Entrées non-objet ignorées (corps de requête non fiable)
    assert.strictEqual(mergeFloatingEffects([null, 42, {}] as any, look), null);
    // Globaux du premier effet qui cible vraiment ; luminosité par cible
    const firstReal = mergeFloatingEffects(
        [
            { effectId: 'b', target: '' },
            { effectId: 'a', target: 'Salon' },
        ],
        look,
    )!;
    assert.strictEqual(firstReal.speedSec, 30);
    assert.strictEqual(firstReal.brightness, 50);
    assert.strictEqual(firstReal.perTarget!.salon.brightness, 50);

    // resolveFloating : liste → config fusionnée via la bibliothèque
    const fromList = resolveFloating({
        effects: [
            { effectId: 'neon-rose', target: 'Salon' },
            { effectId: 'aurora', target: 'Chambre' },
        ],
    });
    assert.deepStrictEqual(fromList!.target, ['Salon', 'Chambre']);
    assert.strictEqual(fromList!.speedSec, 45);
    assert.deepStrictEqual(fromList!.perTarget!.chambre.palette, [
        '#0b3d2e',
        '#1b7f5c',
        '#2ec4b6',
        '#3a0ca3',
        '#4361ee',
    ]);
    assert.strictEqual(
        resolveFloating({ effects: [{ effectId: 'nope', target: 'X' }] }),
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
