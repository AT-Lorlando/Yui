import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isoler le registre de colis AVANT d'importer le watcher (module tracker).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-deliveries-w-'));
process.env.YUI_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });

import {
    classifyDelivery,
    evaluateDeliveries,
    evaluateDeliveriesText,
    parseSearchOutput,
    transitionCandidate,
} from './deliveries';
import { listParcels, takeTransitions } from '../../deliveries/tracker';

// Hermétique : sans code postal ni clé, aucun appel réseau transporteur.
// (Après les imports : dotenv, chargé par les modules, re-remplit l'env.)
process.env.DELIVERIES_POSTAL_CODE = '';
process.env.LAPOSTE_API_KEY = '';

const block = (id: string, from: string, subject: string, snippet = '') =>
    [
        `ID: ${id}`,
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
    // parseSearchOutput : découpage + extraction ID/De/Objet/Apercu
    {
        const mails = parseSearchOutput(
            output(
                block(
                    'aaa111',
                    'Amazon.fr <avis-expedition@amazon.fr>',
                    "Votre colis arrive aujourd'hui",
                    'Livraison prévue avant 22h',
                ),
                block('bbb222', 'Colissimo <ne@colissimo.fr>', 'Colis expédié'),
            ),
        );
        assert.strictEqual(mails.length, 2);
        assert.strictEqual(mails[0].id, 'aaa111');
        assert.strictEqual(mails[0].subject, "Votre colis arrive aujourd'hui");
        assert.ok(mails[1].from.includes('Colissimo'));
    }

    // classifyDelivery : sujets types (dont réels) → bonne catégorie
    {
        const cases: [string, string, string | null][] = [
            ["Votre colis arrive aujourd'hui", '', 'arriving'],
            ['Votre colis est en cours de livraison', '', 'arriving'],
            ["Votre commande sera livrée aujourd'hui", '', 'arriving'],
            ['Votre colis est disponible en point relais', '', 'pickup'],
            ['Votre colis a été livré', '', 'delivered'],
            ['Votre commande a été expédiée', '', 'shipped'],
            // Sujets réels observés dans la boîte (05/09)
            ['Livré : « HENDI Plateau de Service,... »', '', 'delivered'],
            ['Nous avons un colis pour vous !', '', 'shipped'],
            ['Ta commande est en route !', '', 'shipped'],
            ['Offre exclusive : -20% ce week-end', 'profitez-en', null],
            [
                'Nous avons trouvé quelque chose qui pourrait vous plaire',
                'Découvrez des articles similaires',
                null,
            ],
        ];
        for (const [subject, snippet, expected] of cases) {
            assert.strictEqual(
                classifyDelivery({ subject, snippet }),
                expected,
                `« ${subject} » → attendu ${expected}`,
            );
        }
    }

    // evaluateDeliveriesText (mails sans numéro) : importance + marketing
    {
        const events = evaluateDeliveriesText(
            output(
                block(
                    'a1',
                    'Amazon.fr <avis@amazon.fr>',
                    "Votre colis arrive aujourd'hui",
                    'avant 22h',
                ),
                block(
                    'a2',
                    'ASOS <orders@asos.com>',
                    'Ta commande est en route !',
                ),
                block(
                    'a3',
                    'Amazon.fr <promo@amazon.fr>',
                    'Ventes flash du jour',
                ),
            ),
        );
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].importance, 'utile');
        assert.strictEqual(events[1].importance, 'info');
    }

    // evaluateDeliveries : mail Colis Privé avec numéro dans le corps →
    // colis enregistré + transition notifiée ; mail ASOS sans numéro →
    // candidat "mail seul" ; marketing ignoré.
    {
        const search = output(
            block(
                'cp1',
                'Colis Prive <livraison@notification.colisprive.com>',
                'Nous avons un colis pour vous !',
                'Votre colis est en route !',
            ),
            block(
                'as1',
                'ASOS <orders@asos.com>',
                'Ta commande est en route !',
            ),
        );
        const body =
            'Objet: Nous avons un colis pour vous !\n--- Corps ---\n' +
            'Votre colis AMAZON 510 053 223 819 vient de nous être confié.';
        const calls: string[] = [];
        const events = await evaluateDeliveries(
            async (tool, args) => {
                calls.push(tool);
                if (tool === 'search_emails') return search;
                if (tool === 'get_email') {
                    assert.strictEqual(args?.messageId, 'cp1');
                    return body;
                }
                throw new Error(`tool inattendu: ${tool}`);
            },
            { pollMinutes: 30 },
        );
        // 1 candidat mail-seul (ASOS) + 1 transition (colis créé, shipped)
        assert.strictEqual(events.length, 2);
        const parcelEvent = events.find((e) =>
            e.facts.includes('510053223819'),
        );
        assert.ok(parcelEvent, 'transition du colis notifiée');
        assert.strictEqual(parcelEvent.importance, 'info');
        assert.ok(parcelEvent.facts.includes('expédié'));
        const asos = events.find((e) => e.facts.includes('ASOS'));
        assert.ok(asos, 'mail ASOS sans numéro notifié quand même');

        const parcels = listParcels();
        assert.strictEqual(parcels.length, 1);
        assert.strictEqual(parcels[0].tracking, '510053223819');
        assert.strictEqual(parcels[0].carrier, 'colisprive');
        assert.strictEqual(parcels[0].label, 'Colis Prive');

        // Second poll identique : aucun nouvel événement pour le colis
        // (même statut), le mail ASOS ressort (dédupliqué par l'engine).
        const again = await evaluateDeliveries(
            async (tool) => (tool === 'search_emails' ? search : body),
            { pollMinutes: 30 },
        );
        assert.ok(!again.some((e) => e.facts.includes('510053223819')));
    }

    // transitionCandidate : formulation + importance
    {
        takeTransitions();
        const t = {
            parcel: {
                id: 'p1',
                tracking: '510053223819',
                carrier: 'colisprive' as const,
                label: 'AMAZON',
                source: 'mail' as const,
                status: 'out_for_delivery' as const,
                estimatedDate: '2026-09-05',
                events: [
                    {
                        date: '05/09/2026',
                        label: 'Pris en charge par le livreur',
                    },
                ],
                createdAt: 0,
                updatedAt: 0,
            },
            from: 'in_transit' as const,
            to: 'out_for_delivery' as const,
        };
        const c = transitionCandidate(t);
        assert.strictEqual(c.importance, 'utile');
        assert.ok(c.facts.includes('AMAZON (colisprive)'));
        assert.ok(c.facts.includes('en cours de livraison'));
        assert.ok(c.facts.includes('2026-09-05'));
        assert.strictEqual(c.subject, 'livraison-p1-out_for_delivery');
    }

    console.log('All deliveries tests passed');
}

run()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
