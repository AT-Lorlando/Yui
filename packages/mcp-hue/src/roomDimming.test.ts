import assert from 'assert';
import { dimmingBody, isPureDimming } from './roomDimming';

function run(): void {
    const on = [true, true, true];
    // Luminosité seule sur une pièce allumée → gradateur v2.
    assert.ok(isPureDimming({ brightness: 40 }, on));
    assert.ok(isPureDimming({ brightness: 40, on: true }, on));
    // Une lampe éteinte : il faut l'allumer → chemin v1.
    assert.ok(!isPureDimming({ brightness: 40 }, [true, false]));
    assert.ok(!isPureDimming({ brightness: 40 }, []));
    // Couleur, blanc, delta, extinction → jamais le gradateur.
    assert.ok(!isPureDimming({ brightness: 40, color: '#ff0000' }, on));
    assert.ok(!isPureDimming({ brightness: 40, colorTempK: 2700 }, on));
    assert.ok(!isPureDimming({ brightnessDelta: 10 }, on));
    assert.ok(!isPureDimming({ brightness: 40, on: false }, on));
    assert.ok(!isPureDimming({ brightness: NaN }, on));
    assert.ok(!isPureDimming({ on: true }, on));

    assert.deepStrictEqual(dimmingBody(40), { dimming: { brightness: 40 } });
    assert.deepStrictEqual(dimmingBody(0, 300), {
        dimming: { brightness: 1 },
        dynamics: { duration: 300 },
    });
    assert.deepStrictEqual(dimmingBody(140), { dimming: { brightness: 100 } });
    console.log('roomDimming.test.ts ok');
}

run();
