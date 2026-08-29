import assert from 'assert';
import { animationManager } from './animationManager';
import type { FloatingConfig, AnimationEffect } from './types';

// Reproductions de « les lumières deviennent impossibles à éteindre ».
//
// Symptôme : quelque chose continue d'envoyer des set_lights on:true après que
// tout a été arrêté, donc chaque extinction est immédiatement annulée.

const CFG: FloatingConfig = {
    engine: 'software',
    target: 'Salon',
    palette: ['#FF0000', '#00FF00'],
    speedSec: 10,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recorder(listLightsDelayMs = 0) {
    const calls: string[] = [];
    const callTool = async (tool: string): Promise<unknown> => {
        if (tool === 'list_lights') {
            if (listLightsDelayMs) await sleep(listLightsDelayMs);
            return [
                { name: 'L1', room: 'Salon' },
                { name: 'L2', room: 'Salon' },
            ];
        }
        calls.push(tool);
        return null;
    };
    return { calls, callTool };
}

/**
 * Deux scènes déclenchées coup sur coup : le premier startFloating attend
 * encore list_lights quand le second démarre. Le second ne voit aucune boucle
 * active à annuler, et les deux posent leur setInterval — mais `this.floating`
 * ne peut en référencer qu'une. L'autre devient orpheline : plus personne ne
 * peut l'arrêter, et elle rallume les lampes indéfiniment.
 */
async function testConcurrentStartLeavesNoOrphan(): Promise<void> {
    const { calls, callTool } = recorder(120);

    await Promise.all([
        animationManager.startFloating(CFG, callTool),
        animationManager.startFloating(CFG, callTool),
    ]);

    await animationManager.stopAll();
    assert.strictEqual(
        animationManager.isFloating(),
        false,
        'aucune boucle ne doit rester active',
    );

    calls.length = 0;
    await sleep(2000); // > un tick complet
    assert.deepStrictEqual(
        calls,
        [],
        `une boucle orpheline continue d'écrire : ${calls.join(', ')}`,
    );
}

/**
 * Une intro programme une image par keyframe via setTimeout. Si l'utilisateur
 * éteint pendant l'intro, les images restantes arrivent après l'extinction et
 * rallument les lampes — stopAll() ne connaît que la boucle flottante.
 */
async function testStopAllCancelsIntro(): Promise<void> {
    const { calls, callTool } = recorder();
    const intro: AnimationEffect[] = [
        {
            type: 'sweep',
            target: 'Salon',
            colors: ['#FF0000', '#00FF00'],
            staggerMs: 400,
            transitionMs: 200,
            startAtMs: 0,
        },
        {
            type: 'flash',
            target: 'Salon',
            colors: ['#FFFFFF'],
            startAtMs: 1500,
        },
    ];

    void animationManager.playIntro(intro, callTool);
    await sleep(150);
    await animationManager.stopAll();

    calls.length = 0;
    await sleep(2500); // au-delà de la fin de l'intro
    assert.deepStrictEqual(
        calls,
        [],
        `des images d'intro arrivent après l'arrêt : ${calls.join(', ')}`,
    );
}

/**
 * Deux extinctions concurrentes : la seconde ne doit pas rendre la main avant
 * que les commandes en vol de la boucle soient retombées, sinon l'ordre
 * d'extinction qui la suit court après une image "on".
 */
async function testConcurrentStopsBothDrain(): Promise<void> {
    const { callTool } = recorder();
    await animationManager.startFloating(CFG, callTool);
    await Promise.all([animationManager.stopAll(), animationManager.stopAll()]);
    assert.strictEqual(animationManager.isFloating(), false);
}

/**
 * Un ordre d'extinction pendant une intro doit couper l'intro. Sans ça,
 * l'utilisateur éteint et les images suivantes rallument juste derrière.
 */
async function testOffDuringIntroCancelsIt(): Promise<void> {
    const { calls, callTool } = recorder();
    const intro: AnimationEffect[] = [
        {
            type: 'sweep',
            target: 'Salon',
            colors: ['#FF0000', '#00FF00'],
            staggerMs: 500,
            transitionMs: 200,
            startAtMs: 0,
        },
    ];
    void animationManager.playIntro(intro, callTool);
    await sleep(100);

    await animationManager.cancelIfAffected('turn_off_all_lights');
    calls.length = 0;
    await sleep(1500);
    assert.deepStrictEqual(
        calls,
        [],
        `l'intro continue après l'extinction : ${calls.join(', ')}`,
    );

    // Un outil sans effet sur les lumières ne coupe rien.
    void animationManager.playIntro(intro, callTool);
    await sleep(100);
    await animationManager.cancelIfAffected('play_music');
    assert.strictEqual(
        animationManager.isIntroPlaying(),
        true,
        'play_music ne doit pas annuler une intro',
    );
    await animationManager.stopAll();
}

async function run(): Promise<void> {
    await testConcurrentStartLeavesNoOrphan();
    await testStopAllCancelsIntro();
    await testOffDuringIntroCancelsIt();
    await testConcurrentStopsBothDrain();
    console.log('All animation lifecycle tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
