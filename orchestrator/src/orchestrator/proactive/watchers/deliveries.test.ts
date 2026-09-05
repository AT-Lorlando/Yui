import assert from 'assert';
import {
    classifyDelivery,
    evaluateDeliveries,
    evaluateDeliveriesText,
    parseSearchOutput,
} from './deliveries';

const block = (from: string, subject: string, snippet = '') =>
    [
        'ID: 18cabc',
        `De: ${from}`,
        `Objet: ${subject}`,
        'Date: il y a 2 h',
        'Lu: Non',
        snippet ? `Apercu: ${snippet}` : '',
    ]
        .filter(Boolean)
        .join('\n');

const output = (...blocks: string[]) =>
    `${blocks.length} email(s) :\n\n${blocks
        .map((b, i) => `[${i + 1}]\n${b}`)
        .join('\n\n---\n\n')}`;

async function run(): Promise<void> {
    // parseSearchOutput : découpage + extraction De/Objet/Apercu
    {
        const mails = parseSearchOutput(
            output(
                block(
                    'Amazon.fr <avis-expedition@amazon.fr>',
                    "Votre colis arrive aujourd'hui",
                    'Livraison prévue avant 22h',
                ),
                block(
                    'Colissimo <ne-pas-repondre@colissimo.fr>',
                    'Colis expédié',
                ),
            ),
        );
        assert.strictEqual(mails.length, 2);
        assert.strictEqual(mails[0].subject, "Votre colis arrive aujourd'hui");
        assert.strictEqual(mails[0].snippet, 'Livraison prévue avant 22h');
        assert.ok(mails[1].from.includes('Colissimo'));
    }

    // classifyDelivery : sujets types (dont réels) → bonne catégorie
    {
        const cases: [string, string, string | null][] = [
            ["Votre colis arrive aujourd'hui", '', 'arriving'],
            ['Votre colis est en cours de livraison', '', 'arriving'],
            ['Suivi', 'votre colis est en cours de distribution', 'arriving'],
            // « sera livrée aujourd'hui » doit gagner sur « livré »
            ["Votre commande sera livrée aujourd'hui", '', 'arriving'],
            ['Votre colis est disponible en point relais', '', 'pickup'],
            ['Votre colis est prêt à être retiré', '', 'pickup'],
            ['Votre colis a été livré', '', 'delivered'],
            ['Votre commande a été expédiée', '', 'shipped'],
            ['Colis en transit', '', 'shipped'],
            ['Offre exclusive : -20% ce week-end', 'profitez-en', null],
            // Sujets réels observés dans la boîte (05/09)
            ['Livré : « HENDI Plateau de Service,... »', '', 'delivered'],
            [
                'Nous avons trouvé quelque chose qui pourrait vous plaire',
                'Découvrez des articles similaires à ce que vous avez vu',
                null,
            ],
        ];
        for (const [subject, snippet, expected] of cases) {
            assert.strictEqual(
                classifyDelivery({ from: '', subject, snippet }),
                expected,
                `« ${subject} » → attendu ${expected}`,
            );
        }
    }

    // evaluateDeliveriesText : importance + filtrage du marketing
    {
        const events = evaluateDeliveriesText(
            output(
                block(
                    'Amazon.fr <avis@amazon.fr>',
                    "Votre colis arrive aujourd'hui",
                    'avant 22h',
                ),
                block('Chronopost <no@chronopost.fr>', 'Colis expédié'),
                block('Amazon.fr <promo@amazon.fr>', 'Ventes flash du jour'),
            ),
        );
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].importance, 'utile');
        assert.ok(events[0].facts.includes('en cours de livraison'));
        assert.ok(events[0].facts.includes('Amazon.fr'));
        assert.strictEqual(events[1].importance, 'info');
    }

    // Clés de dédup : distinctes par mail, stables entre deux polls
    {
        const text = output(
            block('A <a@a.fr>', "Colis 1 arrive aujourd'hui"),
            block('B <b@b.fr>', "Colis 2 arrive aujourd'hui"),
        );
        const first = evaluateDeliveriesText(text);
        const second = evaluateDeliveriesText(text);
        assert.notStrictEqual(first[0].subject, first[1].subject);
        assert.deepStrictEqual(
            first.map((e) => e.subject),
            second.map((e) => e.subject),
        );
    }

    // evaluateDeliveries : requête par défaut + boîte vide
    {
        let seenQuery = '';
        const events = await evaluateDeliveries(
            async (_tool, args) => {
                seenQuery = String(args?.query);
                return 'Aucun email pour la recherche : "…"';
            },
            { pollMinutes: 30 },
        );
        assert.deepStrictEqual(events, []);
        assert.ok(seenQuery.includes('amazon.fr'));
        assert.ok(seenQuery.includes('newer_than:1d'));
    }

    // Requête surchargée respectée
    {
        let seenQuery = '';
        await evaluateDeliveries(
            async (_tool, args) => {
                seenQuery = String(args?.query);
                return 'Aucun email';
            },
            { pollMinutes: 30, query: 'from:custom.fr' },
        );
        assert.strictEqual(seenQuery, 'from:custom.fr');
    }

    console.log('All deliveries tests passed');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
