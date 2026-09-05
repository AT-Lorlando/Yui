import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-content-'));
process.env.YUI_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });

import {
    ageFromRelativeDate,
    extractItemsFromSubject,
    findParcelContent,
    isShipmentSubject,
    resolveByDeliveryDate,
} from './content';
import { upsertFromMail, listParcels, takeTransitions } from './tracker';

// Hermétique : sans code postal ni clé, aucun appel réseau transporteur.
// (Après les imports : dotenv, chargé par les modules, re-remplit l'env.)
process.env.DELIVERIES_POSTAL_CODE = '';
process.env.LAPOSTE_API_KEY = '';

// Sortie search_emails réaliste (sujets réels de la boîte, 05/09).
const AMAZON_SEARCH = `5 email(s) :

[1]
ID: mail-livre-hendi
De: "Amazon.fr" <order-update@amazon.fr>
Objet: Livré : « HENDI Plateau de Service,... »
Date: hier
Lu: Non

---

[2]
ID: mail-exp-shea
De: "Amazon.fr" <expedition@amazon.fr>
Objet: Expédié : "Shea Moisture Activateur de..."
Date: il y a 2 jours
Lu: Oui

---

[3]
ID: mail-exp-shea2
De: "Amazon.fr" <expedition@amazon.fr>
Objet: Expédié : 2 "SheaMoisture..."
Date: il y a 2 jours
Lu: Oui

---

[4]
ID: mail-avis
De: "Amazon.fr" <avis@amazon.fr>
Objet: Votre commande Amazon récente a-t-elle répondu à vos attentes ? Notez-la
Date: il y a 2 jours
Lu: Non

---

[5]
ID: mail-exp-hendi
De: "Amazon.fr" <expedition@amazon.fr>
Objet: Expédié : "HENDI Plateau de Service,..."
Date: il y a 2 jours
Lu: Oui`;

function makeParcel(over: Record<string, unknown> = {}) {
    const p = upsertFromMail(
        {
            tracking: (over.tracking as string) ?? '510053223819',
            carrier: 'colisprive',
        },
        {
            status: 'out_for_delivery',
            label: (over.label as string) ?? 'AMAZON',
        },
    );
    takeTransitions();
    return { ...p, createdAt: Date.now() - 2 * 86_400_000, ...over };
}

async function run(): Promise<void> {
    // extractItemsFromSubject — formats réels Amazon
    assert.strictEqual(
        extractItemsFromSubject('Expédié : "Shea Moisture Activateur de..."'),
        'Shea Moisture Activateur de…',
    );
    assert.strictEqual(
        extractItemsFromSubject('Expédié : 2 "SheaMoisture..."'),
        '2× SheaMoisture…',
    );
    assert.strictEqual(
        extractItemsFromSubject('Livré : « HENDI Plateau de Service,... »'),
        'HENDI Plateau de Service…',
    );
    assert.strictEqual(
        extractItemsFromSubject('Ta commande est en route !'),
        null,
    );

    // ageFromRelativeDate
    assert.strictEqual(ageFromRelativeDate('il y a 2h'), 0);
    assert.strictEqual(ageFromRelativeDate('hier'), 1);
    assert.strictEqual(ageFromRelativeDate('il y a 3 jours'), 3);

    // isShipmentSubject filtre les avis/promos
    assert.ok(isShipmentSubject('Expédié : "X"'));
    assert.ok(
        !isShipmentSubject(
            'Nous avons trouvé quelque chose qui pourrait vous plaire',
        ),
    );

    // Règle des dates : « Livré : HENDI » hier ≠ colis livré aujourd'hui →
    // HENDI écarté (Expédié compris) ; « Livré » du même jour → match direct.
    {
        const mk = (id: string, subject: string, ageDays: number) => ({
            id,
            subject,
            ageDays,
            items: extractItemsFromSubject(subject),
        });
        const cands = [
            mk('livre-hendi', 'Livré : « HENDI Plateau de Service,... »', 1),
            mk('exp-hendi', 'Expédié : "HENDI Plateau de Service,..."', 2),
            mk('exp-shea', 'Expédié : 2 "SheaMoisture..."', 2),
        ];
        // Colis livré aujourd'hui (age 0) : HENDI (livré hier) écarté.
        const kept = resolveByDeliveryDate(cands, 0);
        assert.deepStrictEqual(
            kept.map((c) => c.id),
            ['exp-shea'],
        );
        // Colis livré HIER : le « Livré » du même jour est le match direct.
        const direct = resolveByDeliveryDate(cands, 1);
        assert.deepStrictEqual(
            direct.map((c) => c.id),
            ['livre-hendi'],
        );
        // Colis pas encore livré : les articles déjà livrés sont écartés.
        const transit = resolveByDeliveryDate(cands, null);
        assert.deepStrictEqual(
            transit.map((c) => c.id),
            ['exp-shea'],
        );
    }

    // Join exact : le numéro dans un corps → « sûr », même avec plusieurs
    // candidats.
    {
        const parcel = makeParcel({});
        const match = await findParcelContent(
            parcel as never,
            new Set(),
            async (tool, args) => {
                if (tool === 'search_emails') return AMAZON_SEARCH;
                if (args?.messageId === 'mail-livre-hendi') {
                    return 'corps sans numero';
                }
                if (args?.messageId === 'mail-exp-shea') {
                    return 'Suivi transporteur : 510 053 223 819';
                }
                return 'rien';
            },
        );
        assert.ok(match);
        assert.strictEqual(match.confidence, 'sûr');
        assert.strictEqual(match.mailId, 'mail-exp-shea');
        assert.strictEqual(match.content, 'Shea Moisture Activateur de…');
    }

    // Ambigu sans join exact : le LLM tranche (mock JSON), les mails déjà
    // réclamés sont exclus.
    {
        const parcel = makeParcel({});
        let llmUser = '';
        const match = await findParcelContent(
            parcel as never,
            new Set(['mail-exp-hendi', 'mail-livre-hendi']),
            async (tool) =>
                tool === 'search_emails' ? AMAZON_SEARCH : 'corps sans numero',
            async (_sys, user) => {
                llmUser = user;
                return '{"choix": 2, "articles": "2 sprays SheaMoisture"}';
            },
        );
        assert.ok(match);
        assert.strictEqual(match.confidence, 'probable');
        assert.strictEqual(match.mailId, 'mail-exp-shea2');
        assert.strictEqual(match.content, '2 sprays SheaMoisture');
        assert.ok(
            !llmUser.includes('HENDI'),
            'mails réclamés exclus du prompt',
        );
    }

    // Sans LLM : repli sur le candidat à articles le plus proche en date.
    {
        const parcel = makeParcel({});
        const match = await findParcelContent(
            parcel as never,
            new Set(['mail-exp-hendi', 'mail-livre-hendi', 'mail-exp-shea2']),
            async (tool) =>
                tool === 'search_emails' ? AMAZON_SEARCH : 'corps sans numero',
        );
        assert.ok(match);
        assert.strictEqual(match.mailId, 'mail-exp-shea');
        assert.strictEqual(match.confidence, 'probable');
    }

    // Label = nom du transporteur → pas de marchand, pas de recherche.
    {
        const parcel = makeParcel({ label: 'Colis Prive' });
        const match = await findParcelContent(
            parcel as never,
            new Set(),
            async () => {
                throw new Error('ne doit pas chercher');
            },
        );
        assert.strictEqual(match, null);
    }

    assert.ok(listParcels().length >= 1);
    console.log('All content tests passed');
}

run()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
