// Annulation ciblée + détection des changements externes (refonte 09/2026).
//
// Trois exigences : rien ne doit bloquer (l'arrêt est synchrone, drain
// plafonné), une commande lumière ne coupe la boucle QUE si elle touche ses
// lampes, et TOUT changement externe sur une lampe animée (app Hue,
// interrupteur, molette) la coupe immédiatement.
import assert from 'assert';
import {
    animationManager,
    toolTouchesLoop,
    externalEventVerdict,
    type LoopTargets,
} from './animationManager';
import type { FloatingConfig } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INFO: LoopTargets = {
    target: 'Salon',
    names: ['Sapin', 'Bureau'],
    rooms: ['Salon'],
    ids: [3, 7],
};

function testToolTouchesLoop(): void {
    // Globaux : toujours.
    assert.ok(toolTouchesLoop('turn_off_all_lights', {}, INFO));
    assert.ok(toolTouchesLoop('_house_off', {}, INFO));
    assert.ok(toolTouchesLoop('_lights_all_off', {}, INFO));
    // set_lights ciblé : pièce de la boucle, lampe de la boucle, autre pièce.
    assert.ok(toolTouchesLoop('set_lights', { target: 'salon' }, INFO));
    assert.ok(toolTouchesLoop('set_lights', { target: 'Sapin' }, INFO));
    assert.ok(!toolTouchesLoop('set_lights', { target: 'Cuisine' }, INFO));
    assert.ok(!toolTouchesLoop('_lights_toggle', { target: 'Chambre' }, INFO));
    // Cible absente ou globale → prudence.
    assert.ok(toolTouchesLoop('set_lights', {}, INFO));
    assert.ok(toolTouchesLoop('set_lights', { target: 'Appartement' }, INFO));
    // Bulk : othersOff touche tout ; sinon d'après les cibles listées.
    assert.ok(toolTouchesLoop('set_lights_bulk', { othersOff: true }, INFO));
    assert.ok(
        toolTouchesLoop(
            'set_lights_bulk',
            { states: [{ target: 'Cuisine' }, { target: 'Bureau' }] },
            INFO,
        ),
    );
    assert.ok(
        !toolTouchesLoop(
            'set_lights_bulk',
            { states: [{ target: 'Cuisine' }] },
            INFO,
        ),
    );
    // Par lightId : connu de la boucle, inconnu, absent (prudence).
    assert.ok(toolTouchesLoop('set_brightness', { lightId: 7 }, INFO));
    assert.ok(!toolTouchesLoop('turn_off_light', { lightId: 42 }, INFO));
    assert.ok(toolTouchesLoop('set_color', {}, INFO));
    // Pas un outil lumière → jamais.
    assert.ok(!toolTouchesLoop('play_music', {}, INFO));
    console.log('toolTouchesLoop OK');
}

function testExternalEventVerdict(): void {
    const now = 10_000;
    const lastWrite = new Map<string, number>([['sapin', now - 200]]);
    // Écho de notre propre écriture (récent) → on ignore.
    assert.strictEqual(
        externalEventVerdict(INFO, lastWrite, { name: 'Sapin' }, now),
        'ignore-own',
    );
    // Off : TOUJOURS externe (la boucle n'éteint jamais), même dans la fenêtre.
    assert.strictEqual(
        externalEventVerdict(
            INFO,
            lastWrite,
            { name: 'Sapin', off: true },
            now,
        ),
        'stop-off',
    );
    // Changement hors fenêtre d'écho → externe.
    assert.strictEqual(
        externalEventVerdict(INFO, lastWrite, { name: 'Sapin' }, now + 5_000),
        'stop-external',
    );
    // Lampe hors boucle → rien.
    assert.strictEqual(
        externalEventVerdict(INFO, lastWrite, { name: 'Frigo' }, now),
        'ignore-unrelated',
    );
    // grouped_light : sur notre pièce → stop ; ailleurs → rien.
    assert.strictEqual(
        externalEventVerdict(
            INFO,
            lastWrite,
            { room: 'Salon', grouped: true },
            now,
        ),
        'stop-grouped',
    );
    assert.strictEqual(
        externalEventVerdict(
            INFO,
            lastWrite,
            { room: 'Cuisine', grouped: true },
            now,
        ),
        'ignore-unrelated',
    );
    console.log('externalEventVerdict OK');
}

const CFG: FloatingConfig = {
    engine: 'software',
    target: 'Salon',
    palette: ['#FF0000', '#00FF00'],
    speedSec: 10,
};

const LIGHTS = [
    { id: 3, name: 'Sapin', room: 'Salon' },
    { id: 7, name: 'Bureau', room: 'Salon' },
];

function recorder(writeLatencyMs = 0) {
    const calls: Array<{ tool: string; args: any }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const callTool = async (tool: string, args: any): Promise<unknown> => {
        if (tool === 'list_lights') return LIGHTS;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (writeLatencyMs) await sleep(writeLatencyMs);
        calls.push({ tool, args });
        inFlight--;
        return null;
    };
    return { calls, callTool, max: () => maxInFlight };
}

/** Une commande d'une AUTRE pièce laisse la boucle vivre ; la sienne la coupe. */
async function testTargetedCancel(): Promise<void> {
    const { callTool } = recorder();
    await animationManager.startFloating(CFG, callTool);
    assert.ok(animationManager.isFloating());

    await animationManager.cancelIfAffected('set_lights', {
        target: 'Cuisine',
    });
    assert.ok(
        animationManager.isFloating(),
        'une commande cuisine ne doit pas couper une boucle salon',
    );
    await animationManager.cancelIfAffected('turn_off_light', { lightId: 42 });
    assert.ok(animationManager.isFloating(), 'lightId hors boucle → survit');

    await animationManager.cancelIfAffected('set_lights', { target: 'Salon' });
    assert.ok(!animationManager.isFloating(), 'sa pièce → coupée');
    console.log('targeted cancel OK');
}

/** L'arrêt ne bloque jamais : bridge accroché → retour sous le plafond de drain. */
async function testCancelNeverBlocks(): Promise<void> {
    const callTool = async (tool: string): Promise<unknown> => {
        if (tool === 'list_lights') return LIGHTS;
        await sleep(60_000); // bridge accroché
        return null;
    };
    await animationManager.startFloating(CFG, callTool);
    const t0 = Date.now();
    await animationManager.cancelIfAffected('turn_off_all_lights');
    const took = Date.now() - t0;
    assert.ok(
        took < 1_000,
        `l'arrêt a bloqué ${took}ms derrière un bridge accroché`,
    );
    assert.ok(!animationManager.isFloating());
    console.log(`cancel non bloquant OK (${took}ms)`);
}

/** Événements SSE : écho de nos écritures ignoré, changement externe → stop. */
async function testExternalEventsStopLoop(): Promise<void> {
    const { callTool } = recorder();
    await animationManager.startFloating(CFG, callTool);
    assert.ok(animationManager.isFloating());

    // Écho immédiat de notre propre écriture → la boucle continue.
    animationManager.onLightEvent({ name: 'Sapin' });
    assert.ok(animationManager.isFloating(), 'écho propre → survit');

    // Lampe hors boucle → rien.
    animationManager.onLightEvent({ name: 'Frigo', off: true });
    assert.ok(animationManager.isFloating(), 'lampe inconnue → survit');

    // Extinction externe d'une lampe animée → stop immédiat.
    animationManager.onLightEvent({ name: 'Sapin', off: true });
    assert.ok(!animationManager.isFloating(), 'off externe → coupée');

    // grouped_light (contrôle de pièce) → stop.
    await animationManager.startFloating(CFG, callTool);
    animationManager.onLightEvent({ room: 'Salon', grouped: true });
    assert.ok(!animationManager.isFloating(), 'grouped sur sa pièce → coupée');

    // Molette / écriture directe sur la pièce → stop ; autre pièce → survit.
    await animationManager.startFloating(CFG, callTool);
    assert.strictEqual(
        await animationManager.interruptIfRoomTouched('Cuisine'),
        false,
    );
    assert.ok(animationManager.isFloating());
    assert.strictEqual(
        await animationManager.interruptIfRoomTouched('Salon'),
        true,
    );
    assert.ok(!animationManager.isFloating());
    console.log('événements externes OK');
}

/** Bridge lent : les ticks en retard sont sautés, jamais empilés. */
async function testSlowBridgeNoBacklog(): Promise<void> {
    // 2 lampes × 600 ms > tick de 800 ms → le tick suivant doit être sauté.
    const { callTool, max } = recorder(600);
    await animationManager.startFloating(CFG, callTool);
    await sleep(2_600); // ~3 ticks
    await animationManager.stopAll();
    assert.strictEqual(
        max(),
        1,
        `écritures concurrentes détectées (max ${max()}) — backlog de ticks`,
    );
    console.log('pas de backlog OK');
}

async function run(): Promise<void> {
    testToolTouchesLoop();
    testExternalEventVerdict();
    await testTargetedCancel();
    await testCancelNeverBlocks();
    await testExternalEventsStopLoop();
    await testSlowBridgeNoBacklog();
    console.log('All animation targeting tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
