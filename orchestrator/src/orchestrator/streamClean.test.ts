import assert from 'assert';
import {
    StreamCleaner,
    stablePrefixLength,
    stripMarkdownForTts,
} from './streamClean';

/** Rejoue `text` en tokens de tailles variées et rend ce qui a été émis. */
function replay(text: string, sizes = [1, 2, 3, 5, 4, 2]): string {
    const cleaner = new StreamCleaner();
    let raw = '';
    let out = '';
    let i = 0;
    let k = 0;
    while (i < text.length) {
        const n = sizes[k++ % sizes.length]!;
        raw += text.slice(i, i + n);
        i += n;
        out += cleaner.push(raw);
    }
    out += cleaner.finish(raw);
    return out;
}

// Le cas réel du 09/10 : liste numérotée streamée → plus aucun caractère perdu.
const postits =
    'Voici tes post-its :\n1. Répondre à l’alerte sur AT-Lorlando/airgap-sbom\n2. Un mail à traiter dans ta boîte\n3. Lire le seul message qui t’attend\n\nDis-moi ce que tu veux ajouter.';
assert.strictEqual(replay(postits), stripMarkdownForTts(postits));
assert.ok(!replay(postits).includes('2. '), 'marqueurs retirés');
assert.ok(replay(postits).includes('\nLire le seul'), '« Lire » intact');

// Gras / italique / code / couleur hex / titre / puces, toutes tailles de tokens.
const md =
    '# Titre\nIl fait **12 degrés** et le *vent* souffle.\n- un point\n* un autre\nCode `ls -la` et couleur #2E8B57 là.\nFin.';
for (const sizes of [[1], [2], [3], [7], [1, 4, 2, 9]]) {
    assert.strictEqual(
        replay(md, sizes),
        stripMarkdownForTts(md),
        `tokens ${sizes}`,
    );
}

// Un nombre en milieu de phrase n'est pas un marqueur de liste.
const nums = 'Rendez-vous à 15.30 puis 2. étage, ok.';
assert.strictEqual(replay(nums), stripMarkdownForTts(nums));

// Préfixe stable : la ligne en cours est retenue tant qu'elle peut devenir un marqueur.
assert.strictEqual(stablePrefixLength('Voici :\n1.'), 8);
assert.strictEqual(stablePrefixLength('Voici :\n1. '), 8);
assert.strictEqual(
    stablePrefixLength('Voici :\n1. Lire'),
    11,
    'marqueur complet émis, mot en cours retenu',
);
assert.strictEqual(
    stablePrefixLength('Voici :\n1. Lire '),
    'Voici :\n1. Lire '.length,
);
assert.strictEqual(
    stablePrefixLength('un *mot'),
    3,
    'emphase ouverte : le mot est retenu',
);
assert.strictEqual(stablePrefixLength('un *mot* fin '), 'un *mot* fin '.length);

// Jamais de doublon ni de retour en arrière : la sortie est un préfixe du résultat final.
const cleaner = new StreamCleaner();
let acc = '';
let emitted = '';
for (const ch of 'A\n1. B\n2. C') {
    acc += ch;
    emitted += cleaner.push(acc);
    assert.ok(
        stripMarkdownForTts(acc).startsWith(emitted) || emitted === '',
        'préfixe',
    );
}
emitted += cleaner.finish(acc);
assert.strictEqual(emitted, 'A\nB\nC');

console.log('streamClean: ok');
