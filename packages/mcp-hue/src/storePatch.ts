import { colourStatePatch, type ColourState } from './colour';

export interface WriteOpts {
    on?: boolean;
    brightness?: number;
    brightnessDelta?: number;
    color?: string;
    colorTempK?: number;
}

export type StorePatch = ColourState & { on?: boolean; brightness?: number };

/**
 * Ce qu'une écriture propre laisse dans le store, pour une lampe Hue.
 *
 * Le flux SSE du bridge porte aussi la couleur, mais un PUT /groups ne
 * renvoie rien et les events arrivent avec un délai : entre les deux, l'app
 * (poll 8 s, relecture 1,2 s après une scène) lisait un état faux. On
 * reflète donc ce qu'on vient d'écrire, le SSE corrige ensuite si le bridge
 * a arrondi (kelvin → mirek) ou refusé.
 *
 * - Extinction : `on: false` seulement — le bridge garde la couleur d'une
 *   lampe éteinte, et nous aussi.
 * - Delta seul : rien — il n'allume pas, et la luminosité exacte n'est
 *   connue que du bridge.
 * - Sinon allumé, luminosité si absolue, couleur ou blanc (le blanc prime).
 */
export function patchForWrite(opts: WriteOpts): StorePatch {
    if (opts.on === false) return { on: false };
    const deltaOnly =
        opts.brightnessDelta !== undefined && opts.on === undefined;
    if (deltaOnly) return {};
    return {
        on: true,
        ...(opts.brightnessDelta === undefined &&
            opts.brightness !== undefined && { brightness: opts.brightness }),
        ...colourStatePatch(opts),
    };
}
