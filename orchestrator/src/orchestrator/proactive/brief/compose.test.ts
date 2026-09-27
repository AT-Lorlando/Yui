import assert from 'assert';
import {
    buildBriefUser,
    checkComposed,
    templateBrief,
    BRIEF_MAX_CHARS,
    BRIEF_SYSTEM_PROMPT,
} from './compose';
import type { BriefFact } from './facts';

const T = new Date('2026-09-27T08:00:00').getTime();
const f = (subject: string, text: string): BriefFact => ({
    subject,
    text,
    importance: 'utile',
    at: T,
    nature: 'info',
    fingerprint: 'x',
});
const facts = [
    f('a', 'Colis ASOS livré à 14h30'),
    f('b', 'Entretien Kinéis à 10:20 à Toulouse'),
];

async function run(): Promise<void> {
    assert.ok(
        /n'invente rien/i.test(BRIEF_SYSTEM_PROMPT) ||
            /N'invente rien/.test(BRIEF_SYSTEM_PROMPT),
    );
    const user = buildBriefUser({
        momentKind: 'moment-wake',
        momentFacts: 'premières lumières',
        now: T,
        presence: 'home',
        facts,
    });
    assert.ok(
        user.includes('1. Colis ASOS livré à 14h30') &&
            user.includes('2. Entretien Kinéis'),
    );

    // OK : ne cite que des faits.
    const ok = checkComposed(
        'Ton colis ASOS est livré. Tu as ton entretien Kinéis à 10:20 à Toulouse.',
        facts,
    );
    assert.strictEqual(ok.ok, true);
    // Refus : nom propre absent (le kiné) et chiffre absent.
    assert.strictEqual(
        checkComposed('Tu as rendez-vous chez le Kiné à 11:00.', facts).ok,
        false,
    );
    assert.strictEqual(
        checkComposed('Tu as rendez-vous chez Bastien.', facts).ok,
        false,
    );
    // Début de phrase capitalisé toléré, jours/mois tolérés.
    assert.strictEqual(
        checkComposed('Demain lundi, ton entretien Kinéis est à 10:20.', facts)
            .ok,
        true,
    );
    // Longueur : tronqué à la dernière phrase complète.
    const long = checkComposed('Colis ASOS livré à 14h30. '.repeat(30), facts);
    assert.ok(
        long.ok &&
            long.text.length <= BRIEF_MAX_CHARS &&
            long.text.endsWith('.'),
    );

    const tpl = templateBrief('moment-return', facts);
    assert.ok(
        tpl.startsWith(
            'Pendant ton absence : Colis ASOS livré à 14h30 ; Entretien Kinéis',
        ),
    );
    assert.ok(tpl.length <= BRIEF_MAX_CHARS && tpl.endsWith('.'));
    console.log('All compose tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
