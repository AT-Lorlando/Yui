import assert from 'assert';
import {
    hexToHueSat,
    xyToHueSat,
    mirekToKelvin,
    colourStatePatch,
} from './colour';

function near(actual: number, expected: number, tol: number, msg: string) {
    assert.ok(
        Math.abs(actual - expected) <= tol,
        `${msg}: ${actual} attendu ≈ ${expected} (±${tol})`,
    );
}

/** Écart de teinte sur le cercle 0–65535. */
function hueNear(actual: number, expected: number, msg: string) {
    const d = Math.abs(actual - expected);
    near(Math.min(d, 65536 - d), 0, 400, msg);
}

function run(): void {
    // ── hex → hue/sat : saturation HSV, pas HSL ──────────────────────────
    // Le champ `sat` du bridge (et la roue de l'app, qui émet des hex à V=1)
    // sont HSV : un pastel #ffc080 est à moitié saturé, pas saturé à fond.
    assert.deepStrictEqual(hexToHueSat('#ff0000'), { hue: 0, sat: 254 });
    near(hexToHueSat('#ffc080').sat, 127, 1, 'pastel orangé à mi-saturation');
    assert.strictEqual(hexToHueSat('#808080').sat, 0, 'gris = blanc');
    assert.strictEqual(hexToHueSat('#ffffff').sat, 0);
    assert.strictEqual(hexToHueSat('#000000').sat, 0, 'noir : pas de NaN');
    near(hexToHueSat('#ffe0c0').sat, 63, 1, 'pastel clair');
    hueNear(hexToHueSat('#00ff00').hue, 21845, 'vert');
    hueNear(hexToHueSat('#0000ff').hue, 43690, 'bleu');
    assert.strictEqual(hexToHueSat('FF0000').hue, 0, 'sans dièse accepté');
    assert.throws(() => hexToHueSat('#12'), /Invalid hex/);

    // ── xy (CIE 1931) → hue/sat : l'inverse de ce que set_color envoie ───
    // Primaires sRGB.
    {
        const red = xyToHueSat(0.64, 0.33);
        hueNear(red.hue, 0, 'primaire rouge');
        near(red.sat, 254, 2, 'rouge saturé');
        const green = xyToHueSat(0.3, 0.6);
        hueNear(green.hue, 21845, 'primaire vert');
        near(green.sat, 254, 2, 'vert saturé');
        const blue = xyToHueSat(0.15, 0.06);
        hueNear(blue.hue, 43690, 'primaire bleu');
        near(blue.sat, 254, 2, 'bleu saturé');
    }
    // Primaires du gamut C des ampoules Hue (hors sRGB) : saturées à fond,
    // teinte conservée.
    {
        const red = xyToHueSat(0.6915, 0.3083);
        hueNear(red.hue, 0, 'rouge gamut C');
        assert.strictEqual(red.sat, 254);
        // Le bleu gamut C est plus violet que le bleu sRGB : on vérifie la
        // famille, pas l'angle exact.
        const blue = xyToHueSat(0.1532, 0.0475);
        assert.ok(
            blue.hue > 41000 && blue.hue < 48000,
            `bleu gamut C côté bleu (${blue.hue})`,
        );
        assert.strictEqual(blue.sat, 254);
    }
    // Blanc D65 → saturation nulle (c'est ce qui fait qu'un blanc n'est pas
    // affiché comme une couleur dans l'app).
    near(xyToHueSat(0.3127, 0.329).sat, 0, 3, 'blanc D65');
    // Blanc chaud (≈2700 K ≈ #ffb46b) : en HSV c'est un orangé à ~60 % de
    // saturation — c'est pour ça que l'app reconnaît un blanc par
    // `colormode === 'ct'`, jamais par la saturation.
    {
        const warm = xyToHueSat(0.4599, 0.4106);
        assert.ok(
            warm.sat > 100 && warm.sat < 200,
            `blanc chaud mi-saturé (${warm.sat})`,
        );
        assert.ok(
            warm.hue < 9000 || warm.hue > 60000,
            `blanc chaud côté orangé (${warm.hue})`,
        );
    }
    // Teinte invariante à la luminosité : un xy donné reste la même couleur.
    {
        const a = xyToHueSat(0.2, 0.3);
        assert.ok(a.hue >= 0 && a.hue <= 65535);
        assert.ok(a.sat >= 0 && a.sat <= 254);
    }
    // Entrées dégénérées : pas de NaN, un blanc neutre.
    assert.deepStrictEqual(xyToHueSat(0, 0), { hue: 0, sat: 0 });
    assert.deepStrictEqual(xyToHueSat(Number.NaN, 0.3), { hue: 0, sat: 0 });

    // ── mirek → kelvin ──────────────────────────────────────────────────
    assert.strictEqual(mirekToKelvin(370), 2703);
    assert.strictEqual(mirekToKelvin(153), 6536);
    assert.strictEqual(mirekToKelvin(0), undefined);
    assert.strictEqual(mirekToKelvin(undefined), undefined);
    assert.strictEqual(mirekToKelvin(null), undefined);

    // ── patch d'état pour une écriture propre ───────────────────────────
    // Le blanc prime sur la couleur, comme dans HueController.setRoomLights.
    assert.deepStrictEqual(colourStatePatch({ colorTempK: 2700 }), {
        ct: 2700,
        colormode: 'ct',
    });
    assert.deepStrictEqual(
        colourStatePatch({ colorTempK: 2700, color: '#ff0000' }),
        { ct: 2700, colormode: 'ct' },
    );
    assert.deepStrictEqual(colourStatePatch({ color: '#ff0000' }), {
        hue: 0,
        saturation: 254,
        colormode: 'hs',
    });
    assert.deepStrictEqual(colourStatePatch({}), {});
    // Kelvin borné à ce que le bridge accepte (2000–6500).
    assert.deepStrictEqual(colourStatePatch({ colorTempK: 1000 }), {
        ct: 2000,
        colormode: 'ct',
    });
    assert.deepStrictEqual(colourStatePatch({ colorTempK: 9000 }), {
        ct: 6500,
        colormode: 'ct',
    });
    // Hex invalide : pas de patch couleur plutôt qu'une exception après
    // une écriture déjà partie au bridge.
    assert.deepStrictEqual(colourStatePatch({ color: 'rouge' }), {});

    console.log('All colour tests passed');
}

run();
