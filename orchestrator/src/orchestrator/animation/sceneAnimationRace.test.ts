import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Registre de scènes/effets isolé AVANT les imports (dataPath lit l'env).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-anim-race-'));
process.env.YUI_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });

import { animationManager, shouldCancel } from './animationManager';
import type { FloatingConfig } from './types';
import { createScene, listScenes, runScene, bumpSceneRun } from '../scenes';
import { upsertEffect } from './effectLibrary';

// Reproductions des deux bugs rapportés le 05/09 :
//  1. « j'éteins et la couleur flottante revient » — l'extinction tombe
//     pendant les phases d'une scène (aucune animation active à annuler),
//     puis le startFloating différé de fin de scène rallume tout ;
//  2. « je change de scène et ça revient à la flottante » — deux runs de
//     scène concurrents, le premier pose sa boucle après la fin du second.

const CFG: FloatingConfig = {
    engine: 'software',
    target: 'Salon',
    palette: ['#FF0000', '#00FF00'],
    speedSec: 10,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recorder(lightDelayMs = 0) {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const callTool = async (
        tool: string,
        args: Record<string, unknown> = {},
    ): Promise<unknown> => {
        if (tool === 'list_lights') {
            return [
                { name: 'L1', room: 'Salon' },
                { name: 'L2', room: 'Salon' },
            ];
        }
        if (lightDelayMs) await sleep(lightDelayMs);
        calls.push({ tool, args });
        return null;
    };
    return { calls, callTool };
}

/** Bug 1 (niveau manager) : un jeton périmé ne démarre rien. */
async function testStaleTokenNeverStarts(): Promise<void> {
    const { calls, callTool } = recorder();
    await animationManager.stopAll();
    const token = animationManager.currentEpoch();

    // Extinction pendant la scène : aucune animation active, mais la
    // génération DOIT avancer pour périmer le jeton.
    await animationManager.cancelIfAffected('turn_off_all_lights');

    await animationManager.startFloating(CFG, callTool, token);
    assert.strictEqual(
        animationManager.isFloating(),
        false,
        'une flottante au jeton périmé ne doit pas démarrer',
    );
    calls.length = 0;
    await sleep(1200);
    assert.deepStrictEqual(calls, [], 'aucune écriture après extinction');
}

/** Bug 1 (niveau scène) : off pendant le state → pas de flottante. */
async function testOffDuringSceneStateSkipsFloating(): Promise<void> {
    createScene({
        name: 'RaceOff',
        icon: 'lucide:play',
        color: '#fff',
        description: '',
        setup: [],
        state: [
            { tool: 'set_lights', args: { target: 'Salon', on: true } },
            { tool: 'slow_marker', args: {} },
        ],
        floating: CFG,
    });

    const { calls, callTool } = recorder(150); // chaque action prend 150 ms
    const sceneP = runScene('raceoff-not-an-id', callTool); // warm-up id? non
    await sceneP; // (id inconnu → no-op, juste pour le typage)

    const scene = listScenes().find((s) => s.name === 'RaceOff')!;
    const runP = runScene(scene.id, callTool);
    await sleep(180); // en plein milieu du state
    // L'utilisateur éteint : chemin public = bump + cancel.
    assert.ok(shouldCancel('turn_off_all_lights'));
    bumpSceneRun();
    await animationManager.cancelIfAffected('turn_off_all_lights');

    await runP;
    assert.strictEqual(
        animationManager.isFloating(),
        false,
        'la flottante de la scène doublée ne doit pas démarrer',
    );
    calls.length = 0;
    await sleep(1200);
    assert.deepStrictEqual(
        calls,
        [],
        `écritures après extinction : ${calls.map((c) => c.tool).join(', ')}`,
    );
}

/** Bug 2 : deux scènes coup sur coup → seule la seconde pose sa boucle. */
async function testSceneSwitchKeepsOnlyLatestFloating(): Promise<void> {
    upsertEffect({
        id: 'fx-a',
        name: 'Fx A',
        kind: 'floating',
        palette: ['#111111', '#222222'],
        speedSec: 10,
    });
    createScene({
        name: 'SwitchA',
        icon: 'lucide:play',
        color: '#fff',
        description: '',
        setup: [],
        state: [
            { tool: 'set_lights', args: { target: 'Salon', on: true } },
            { tool: 'set_lights', args: { target: 'Salon', on: true } },
        ],
        // Référence d'effet (nouvelle forme) — vérifie la résolution au run.
        floating: { effectId: 'fx-a', target: 'Salon' },
    });
    createScene({
        name: 'SwitchB',
        icon: 'lucide:play',
        color: '#fff',
        description: '',
        setup: [],
        state: [{ tool: 'set_lights', args: { target: 'Salon', on: false } }],
    });
    const a = listScenes().find((s) => s.name === 'SwitchA')!;
    const b = listScenes().find((s) => s.name === 'SwitchB')!;

    const { calls, callTool } = recorder(120);
    const pA = runScene(a.id, callTool);
    await sleep(100); // A est dans son state
    const pB = runScene(b.id, callTool); // B double A
    await Promise.all([pA, pB]);

    assert.strictEqual(
        animationManager.isFloating(),
        false,
        'la flottante de A (doublée par B, sans flottante) ne doit pas tourner',
    );
    calls.length = 0;
    await sleep(1200);
    assert.deepStrictEqual(
        calls,
        [],
        `boucle orpheline de A : ${calls.map((c) => c.tool).join(', ')}`,
    );
}

/** Le même scénario où B a AUSSI une flottante : celle de B survit. */
async function testSceneSwitchToFloatingSceneKeepsB(): Promise<void> {
    createScene({
        name: 'SwitchC',
        icon: 'lucide:play',
        color: '#fff',
        description: '',
        setup: [],
        state: [{ tool: 'set_lights', args: { target: 'Salon', on: true } }],
        floating: { effectId: 'fx-a', target: 'Salon' },
    });
    const a = listScenes().find((s) => s.name === 'SwitchA')!;
    const c = listScenes().find((s) => s.name === 'SwitchC')!;

    const { callTool } = recorder(120);
    const pA = runScene(a.id, callTool);
    await sleep(100);
    const pC = runScene(c.id, callTool);
    await Promise.all([pA, pC]);

    assert.strictEqual(
        animationManager.isFloating(),
        true,
        'la flottante de la DERNIÈRE scène doit tourner',
    );
    await animationManager.stopAll();
}

async function run(): Promise<void> {
    await testStaleTokenNeverStarts();
    await testOffDuringSceneStateSkipsFloating();
    await testSceneSwitchKeepsOnlyLatestFloating();
    await testSceneSwitchToFloatingSceneKeepsB();
    console.log('All scene animation race tests passed');
}

run()
    .catch((e) => {
        console.error(e.message ?? e);
        process.exit(1);
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
