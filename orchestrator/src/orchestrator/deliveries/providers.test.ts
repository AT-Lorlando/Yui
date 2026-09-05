import assert from 'assert';
import {
    parseColisPrivePage,
    parseOkapiResponse,
    statusFromColisPriveLabel,
    statusFromOkapiCode,
} from './providers';

// Extrait fidèle de la vraie page DetailColis.aspx (05/09/2026).
const CP_HTML = `
<html><head><style>.x{}</style><script>var y=1;</script></head><body>
<h1>Suivi de votre colis expédié par AMAZON</h1>
<div>N° de colis 510 053 223 819</div>
<div>Statut</div><div>Votre colis est en cours de distribution par le livreur</div>
<div>Adresse du destinataire</div><div>2 RUE EXEMPLE 31300 TOULOUSE</div>
<h2>Historique de votre colis</h2>
<table><caption>Historique de votre colis - Liste des statuts des colis par date</caption>
<tr><th>Date</th><th>Statut du colis</th></tr>
<tr><td>05/09/2026</td><td>Votre colis est en cours de distribution par le livreur</td></tr>
<tr><td>05/09/2026</td><td>Votre colis est arrivé sur notre agence régionale de distribution.</td></tr>
<tr><td>04/09/2026</td><td>Votre colis est pris en charge par Colis Privé. Il va être expédié vers notre agence régionale de distribution.</td></tr>
<tr><td>04/09/2026</td><td>Votre colis est en cours de préparation par l'expéditeur. Il nous sera confié prochainement.</td></tr>
</table>
<div>Définir une date de livraison : Replanification non disponible</div>
</body></html>`;

async function run(): Promise<void> {
    // Parse page Colis Privé
    {
        const up = parseColisPrivePage(CP_HTML);
        assert.ok(up, 'page parsée');
        assert.strictEqual(up.status, 'out_for_delivery');
        assert.strictEqual(up.sender, 'AMAZON');
        assert.strictEqual(up.events.length, 4);
        assert.strictEqual(up.events[0].date, '05/09/2026');
        assert.ok(up.events[0].label.includes('en cours de distribution'));
        assert.ok(up.events[3].label.includes('préparation'));
    }

    // Page sans statut (numéro inconnu) → null
    assert.strictEqual(parseColisPrivePage('<html>Erreur</html>'), null);

    // Mapping libellés Colis Privé
    assert.strictEqual(
        statusFromColisPriveLabel('Votre colis a été livré le 05/09'),
        'delivered',
    );
    assert.strictEqual(
        statusFromColisPriveLabel(
            'Votre colis est disponible dans votre point relais',
        ),
        'pickup_ready',
    );
    assert.strictEqual(
        statusFromColisPriveLabel(
            'Votre colis est pris en charge par Colis Privé',
        ),
        'in_transit',
    );

    // Mapping codes Okapi
    assert.strictEqual(statusFromOkapiCode('DI1'), 'delivered');
    assert.strictEqual(statusFromOkapiCode('MD2'), 'out_for_delivery');
    assert.strictEqual(statusFromOkapiCode('ET1'), 'in_transit');
    assert.strictEqual(statusFromOkapiCode('PC1'), 'shipped');
    assert.strictEqual(statusFromOkapiCode('ND1'), 'problem');
    assert.strictEqual(statusFromOkapiCode('AG1'), 'pickup_ready');

    // Parse réponse Okapi (événements anciens → récents chez La Poste)
    {
        const up = parseOkapiResponse({
            shipment: {
                idShip: '6A12345678901',
                isFinal: false,
                estimDate: '2026-09-08T00:00:00+02:00',
                event: [
                    {
                        date: '2026-09-04T10:00:00+02:00',
                        label: 'Pris en charge',
                        code: 'PC1',
                    },
                    {
                        date: '2026-09-05T08:00:00+02:00',
                        label: 'En cours de distribution',
                        code: 'MD2',
                    },
                ],
            },
        });
        assert.ok(up);
        assert.strictEqual(up.status, 'out_for_delivery');
        assert.strictEqual(up.events[0].label, 'En cours de distribution');
        assert.strictEqual(up.estimatedDate, '2026-09-08');
    }
    assert.strictEqual(parseOkapiResponse({ returnCode: 404 }), null);

    console.log('All providers tests passed');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
