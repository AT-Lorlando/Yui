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
