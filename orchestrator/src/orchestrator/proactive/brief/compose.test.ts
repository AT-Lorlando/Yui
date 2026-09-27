import assert from 'assert';
import {
    buildBriefUser,
    checkComposed,
    lexiconTokens,
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

    // Aucun fait : phrase neutre par moment, jamais un préfixe orphelin (« ... :. »).
    assert.strictEqual(templateBrief('moment-wake', []), 'Bonjour.');
    assert.strictEqual(
        templateBrief('moment-return', []),
        'Rien de particulier pendant ton absence.',
    );
    assert.strictEqual(
        templateBrief('moment-bedtime', []),
        'Rien à signaler avant de dormir.',
    );
    assert.strictEqual(
        templateBrief('moment-departure', []),
        'Rien à signaler avant de partir.',
    );
    assert.strictEqual(templateBrief('on-demand', []), 'Rien de nouveau.');

    // Guillemets : pas d'exemption — un nom propre cité reste vérifié.
    assert.strictEqual(
        checkComposed('Ton entretien « Kinéis » est à 10:20.', facts).ok,
        true,
    );
    assert.strictEqual(
        checkComposed('Ton rendez-vous « Bastien » est à 10:20.', facts).ok,
        false,
    );

    // Sans ponctuation dans les 400 premiers caractères : coupe sèche + « … », toujours ≤ 400.
    const noPunct = checkComposed('a'.repeat(500), facts);
    assert.ok(
        noPunct.ok &&
            noPunct.text.length <= BRIEF_MAX_CHARS &&
            noPunct.text.endsWith('…'),
    );

    // Premier mot d'un fait (sujet externe) : pas une phrase, doit rester
    // toléré même si la sortie du LLM le place en tête (checkComposed garde
    // l'exemption de début de phrase côté sortie, mais le lexique des faits
    // ne doit pas oublier le mot qui a construit l'exemption).
    const externalFacts = [
        ...facts,
        f('c', 'Koya signale une fuite — cuisine'),
    ];
    assert.strictEqual(
        checkComposed(
            'Pendant ton absence, Koya a signalé une fuite.',
            externalFacts,
        ).ok,
        true,
        'premier mot d’un fait externe toléré',
    );
    assert.strictEqual(
        checkComposed('Bonjour. Sache que Bastien a répondu.', [
            ...facts,
            f('d', 'Bastien a répondu'),
        ]).ok,
        true,
        'premier mot d’un fait toléré même après un point',
    );

    // lexiconTokens : des libellés, pas des phrases — le 1er mot compte aussi.
    {
        const lex = lexiconTokens(['Bastien dîner', 'Point Acme', '10:00']);
        assert.ok(lex.has('Bastien'), 'premier mot capitalisé retenu');
        assert.ok(lex.has('Point') && lex.has('Acme'));
        assert.ok(lex.has('10:00'), 'nombre retenu');
        assert.ok(!lex.has('dîner'), 'mot commun ignoré');
    }

    console.log('All compose tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
