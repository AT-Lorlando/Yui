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
    // L'âge d'un post-it est une attente : la règle est dite au LLM (vécu :
    // « (11 j) » devenu « arrivent dans onze jours »).
    assert.ok(/ouvert depuis N jours/.test(BRIEF_SYSTEM_PROMPT));
    assert.ok(
        /jamais une échéance ni un compte à rebours/.test(BRIEF_SYSTEM_PROMPT),
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
    assert.strictEqual(
        tpl,
        'Pendant ton absence : Colis ASOS livré à 14h30. Entretien Kinéis à 10:20 à Toulouse.',
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

    // ── Vécu (réveil du 05/10, journal muuskg2g-uyyu) : 8 faits, point final
    // « Bonjour. » — le gabarit joignait tout en UNE phrase de 480 caractères
    // et la coupe « au dernier point » retombait sur celui de « Bonjour. ».
    {
        const wake = [
            '« Echange Jeremy Richard | Umake » à 17:00 (Réunion Microsoft Teams)',
            'Mail à traiter : « AT-Lorlando/Koya - 2 internal incidents detected »',
            'Mail à traiter : « AT-Lorlando/Genkin - 1 internal incident detected »',
            'Post-it ouvert depuis 18 jours : Attestation assurance habitation',
            'Post-it ouvert depuis 101 jours : Photo carte CPAM',
            'Post-it ouvert depuis 18 jours : Entretien chaudière',
            'Post-it ouvert depuis 101 jours : Solde PEA + Compte commun',
            'Post-it ouvert depuis 18 jours : Feuille de soin psy',
        ].map((t, i) => f(`w${i}`, t));
        const tplWake = templateBrief('moment-wake', wake);
        assert.ok(tplWake.length <= BRIEF_MAX_CHARS, 'borne respectée');
        assert.ok(
            tplWake.startsWith(
                'Bonjour. « Echange Jeremy Richard | Umake » à 17:00 (Réunion Microsoft Teams). Mail à traiter : « AT-Lorlando/Koya',
            ),
            `le gabarit liste les faits, un par phrase : ${tplWake}`,
        );
        // Coupe à une frontière de fait : chaque fait présent l'est en entier,
        // et le texte est exactement le préfixe + les k premiers faits.
        const kept = wake.filter((x) => tplWake.includes(x.text));
        assert.ok(kept.length >= 3 && kept.length < wake.length);
        assert.strictEqual(
            tplWake,
            `Bonjour. ${kept.map((x) => x.text + '.').join(' ')}`,
        );
        // Les faits gardés sont les premiers (ordre d'importance conservé).
        assert.deepStrictEqual(
            kept.map((x) => x.subject),
            wake.slice(0, kept.length).map((x) => x.subject),
        );

        // Lexique : les heures et dates des faits se disent à la française.
        const okHour = (text: string) =>
            assert.strictEqual(
                checkComposed(text, wake).ok,
                true,
                `devrait passer : ${text}`,
            );
        okHour('Tu as « Echange Jeremy Richard | Umake » à 17 heures.');
        okHour('Ton échange Umake est à 17h.');
        okHour('Ton échange Umake est à 17h00.');
        okHour('Ton échange Umake est à dix-sept heures sur Teams.');
        okHour(
            'Le post-it Attestation assurance habitation attend depuis 18 jours.',
        );
        okHour('La photo CPAM attend depuis 101 jours.');
        // …mais un chiffre absent des faits reste refusé.
        assert.strictEqual(
            checkComposed('Ton échange Umake est à 19 heures.', wake).ok,
            false,
        );
        assert.strictEqual(
            checkComposed('Ton échange Umake est à 17:30.', wake).ok,
            false,
            'une minute inventée est refusée',
        );
        assert.strictEqual(
            checkComposed('Le post-it attend depuis 3 jours.', wake).ok,
            false,
        );
        // Dates ISO : chaque partie se dit (« le 5 octobre »), rien d'autre.
        const dated = [
            f('d', 'Changement d’agenda le 2026-10-05 : « Dentiste » à 09:30'),
        ];
        assert.strictEqual(
            checkComposed('Ton dentiste est le 5 octobre à 9 heures 30.', dated)
                .ok,
            true,
        );
        assert.strictEqual(
            checkComposed('Ton dentiste est le 6 octobre à 9 heures 30.', dated)
                .ok,
            false,
        );
    }

    // lexiconTokens : des libellés, pas des phrases — le 1er mot compte aussi.
    {
        const lex = lexiconTokens(['Bastien dîner', 'Point Acme', '10:00']);
        assert.ok(lex.has('Bastien'), 'premier mot capitalisé retenu');
        assert.ok(lex.has('Point') && lex.has('Acme'));
        assert.ok(lex.has('10:00'), 'nombre retenu');
        assert.ok(
            lex.has('10') && lex.has('00') && lex.has('0'),
            'parties d’une heure',
        );
        assert.ok(lexiconTokens(['07:30']).has('7'), 'zéro de tête toléré');
        assert.ok(!lex.has('dîner'), 'mot commun ignoré');
    }

    console.log('All compose tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
