import assert from 'assert';
import { carrierFromSender, detectParcels, extractEta } from './carriers';

async function run(): Promise<void> {
    // carrierFromSender
    assert.strictEqual(
        carrierFromSender(
            'Colis Prive <livraison@notification.colisprive.com>',
        ),
        'colisprive',
    );
    assert.strictEqual(carrierFromSender('suivi@colissimo.fr'), 'colissimo');
    assert.strictEqual(carrierFromSender('ASOS <orders@asos.com>'), null);

    // URL Colis Privé réelle : numColis = numéro (12) + code postal (5)
    {
        const body =
            'Votre livreur a pris en charge votre colis AMAZON 510 053 223 819. ' +
            "Il vous sera livré aujourd'hui.\n" +
            'Suivre mon colis ( https://www.colisprive.com/moncolis/pages/DetailColis.aspx?numColis=51005322381931300 )';
        const parcels = detectParcels(
            body,
            'Colis Prive <livraison@notification.colisprive.com>',
        );
        assert.strictEqual(parcels.length, 1);
        assert.strictEqual(parcels[0].tracking, '510053223819');
        assert.strictEqual(parcels[0].carrier, 'colisprive');
        assert.ok(parcels[0].url?.includes('numColis=51005322381931300'));
    }

    // Numéro 12 chiffres groupés près de « colis », sans URL
    {
        const parcels = detectParcels(
            'Votre colis 510 053 223 819 est en route',
            'noreply@colisprive.fr',
        );
        assert.strictEqual(parcels[0]?.tracking, '510053223819');
        assert.strictEqual(parcels[0]?.carrier, 'colisprive');
    }

    // Formats sans ambiguïté, indépendants de l'expéditeur
    assert.strictEqual(
        detectParcels('suivi 1Z999AA10123456784', '')[0]?.carrier,
        'ups',
    );
    assert.strictEqual(
        detectParcels('numéro 6A12345678901', '')[0]?.carrier,
        'colissimo',
    );
    assert.strictEqual(
        detectParcels('envoi RR123456789FR', '')[0]?.carrier,
        'colissimo',
    );
    assert.strictEqual(
        detectParcels('n° XY123456789AB', '')[0]?.carrier,
        'chronopost',
    );

    // Pas de faux positif : 12 chiffres sans expéditeur identifié
    assert.strictEqual(
        detectParcels('votre colis 510053223819', 'ASOS <orders@asos.com>')
            .length,
        0,
    );

    // extractEta
    const now = new Date('2026-09-05T10:00:00Z');
    assert.strictEqual(
        extractEta("Il vous sera livré aujourd'hui à l'adresse", now),
        '2026-09-05',
    );
    assert.strictEqual(
        extractEta('votre colis sera livré demain matin', now),
        '2026-09-06',
    );
    assert.strictEqual(
        extractEta('livraison prévue le 08/09', now),
        '2026-09-08',
    );
    assert.strictEqual(
        extractEta('votre commande est en route', now),
        undefined,
    );

    console.log('All carriers tests passed');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
