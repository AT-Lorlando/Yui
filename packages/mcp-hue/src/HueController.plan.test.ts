import assert from 'assert';
import HueController from './HueController';

const plan = HueController.planLightWrites;
const hs = { hue: 43690, sat: 254 };

// Une seule écriture : luminosité + couleur + transition ensemble.
assert.deepStrictEqual(
    plan({ brightness: 100, hueSat: hs, transitionMs: 2500 }),
    [{ on: true, bri: 254, hue: 43690, sat: 254, transitiontime: 25 }],
);
// Blanc : ct, pas hue/sat.
assert.deepStrictEqual(plan({ brightness: 50, colorTempK: 2700, hueSat: hs }), [
    { on: true, bri: 127, ct: 370, transitiontime: 0 },
]);
// Départ en fondu explicite : ON instantané à 1 % avec la couleur, puis rampe.
assert.deepStrictEqual(
    plan({ brightness: 100, hueSat: hs, transitionMs: 3500, fadeFrom: 1 }),
    [
        { on: true, bri: 3, hue: 43690, sat: 254, transitiontime: 0 },
        { on: true, bri: 254, transitiontime: 35 },
    ],
);
// Lampe éteinte + transition + couleur → départ en fondu automatique (pas de
// flash de l'ancienne couleur), depuis 1 %.
const auto = plan({
    brightness: 80,
    hueSat: hs,
    transitionMs: 1000,
    currentlyOff: true,
});
assert.strictEqual(auto.length, 2);
assert.strictEqual(auto[0]!.transitiontime, 0);
assert.strictEqual(auto[0]!.bri, 3);
assert.strictEqual(auto[1]!.bri, 203);
// Lampe éteinte SANS transition → une écriture directe.
assert.strictEqual(
    plan({ brightness: 80, hueSat: hs, currentlyOff: true }).length,
    1,
);
// Lampe allumée + transition → une écriture (transition normale).
assert.strictEqual(
    plan({ brightness: 80, hueSat: hs, transitionMs: 1000 }).length,
    1,
);
console.log('All HueController plan tests passed');
