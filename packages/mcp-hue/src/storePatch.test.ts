import assert from 'assert';
import { patchForWrite } from './storePatch';

// Ce qu'une écriture propre laisse dans le store. Avant, seuls on/brightness
// étaient reflétés : après une scène, l'app montrait encore les couleurs du
// dernier redémarrage (prod : snapshot du 29/09, 18 scènes plus tard).

function run(): void {
    // Extinction : on=false, la couleur mémorisée n'est pas touchée (le
    // bridge garde hue/sat d'une lampe éteinte).
    assert.deepStrictEqual(patchForWrite({ on: false, color: '#ff0000' }), {
        on: false,
    });
    // Delta seul : n'allume pas, la luminosité exacte revient par le SSE.
    assert.deepStrictEqual(patchForWrite({ brightnessDelta: 10 }), {});
    // Allumage simple.
    assert.deepStrictEqual(patchForWrite({}), { on: true });
    assert.deepStrictEqual(patchForWrite({ on: true, brightness: 40 }), {
        on: true,
        brightness: 40,
    });
    // Couleur → hue/sat HSV + mode.
    assert.deepStrictEqual(
        patchForWrite({ brightness: 30, color: '#00ff00' }),
        {
            on: true,
            brightness: 30,
            hue: 21845,
            saturation: 254,
            colormode: 'hs',
        },
    );
    // Blanc → ct kelvin + mode, prime sur la couleur.
    assert.deepStrictEqual(
        patchForWrite({ colorTempK: 2700, color: '#00ff00' }),
        { on: true, ct: 2700, colormode: 'ct' },
    );
    // Delta + on explicite : allumé, luminosité inconnue (bri_inc), couleur
    // relevée.
    assert.deepStrictEqual(
        patchForWrite({ on: true, brightnessDelta: 10, color: '#ff0000' }),
        { on: true, hue: 0, saturation: 254, colormode: 'hs' },
    );
    console.log('All storePatch tests passed');
}

run();
