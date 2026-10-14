import assert from 'assert';
import { cleanBody } from './bodyClean';

function run(): void {
    const full =
        'ID: 1\nDe: x\n--- Corps ---\nBonjour Jérémy,\n\nVotre devis est prêt : 1 240 €.\nVoir https://ex.com/devis\n\nLe 12 oct. 2026 à 10:02, Michel a écrit :\n> ancien message\n> encore\n-- \nMichel\n';
    const out = cleanBody(full);
    assert.ok(out.startsWith('Bonjour Jérémy'));
    assert.ok(out.includes('1 240 €'));
    assert.ok(out.includes('[lien]') && !out.includes('https://'));
    assert.ok(!out.includes('ancien message'), 'citation retirée');
    assert.ok(!out.includes('Michel\n'), 'signature retirée');

    const footer =
        '--- Corps ---\nPromo -50 %\n\nVous recevez cet e-mail car vous êtes abonné. Se désabonner ici.\nMentions légales';
    assert.strictEqual(cleanBody(footer), 'Promo -50 %');

    // pied de page en tête (mail transactionnel) : seule la ligne part
    const top =
        '--- Corps ---\nMerci de ne pas répondre à ce message.\nVotre commande n° 4521 a été expédiée.\nLivraison prévue jeudi 16 octobre entre 8 h et 13 h.\nSuivi colis : 6A123456789.';
    const topOut = cleanBody(top);
    assert.ok(!topOut.includes('ne pas répondre'), topOut);
    assert.ok(topOut.startsWith('Votre commande n° 4521'), topOut);
    assert.ok(topOut.includes('6A123456789'), topOut);
    // pied de page en seconde moitié : coupé à partir de là
    const bottom =
        '--- Corps ---\nBonjour, votre facture de septembre est disponible dans votre espace client.\nMontant : 42 €.\nMerci de ne pas répondre à ce message.\nSociété X, 1 rue Y';
    const bottomOut = cleanBody(bottom);
    assert.ok(bottomOut.endsWith('Montant : 42 €.'), bottomOut);

    const long = '--- Corps ---\n' + 'a'.repeat(5_000);
    assert.strictEqual(cleanBody(long).length, 2_501); // 2500 + '…'

    assert.strictEqual(cleanBody('sans marqueur'), 'sans marqueur');
    assert.strictEqual(
        cleanBody('--- Corps ---\n(corps vide)'),
        '(corps vide)',
    );
    console.log('bodyClean: all tests passed');
}
run();
