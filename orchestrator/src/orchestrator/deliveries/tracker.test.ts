import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isoler le registre dans un dossier jetable AVANT d'importer le tracker.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-deliveries-'));
process.env.YUI_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });

import {
    addManual,
    guessCarrier,
    listParcels,
    removeParcel,
    takeTransitions,
    upsertFromMail,
} from './tracker';

// Hermétique : sans code postal ni clé, aucun appel réseau transporteur.
// (Après les imports : dotenv, chargé par les modules, re-remplit l'env.)
process.env.DELIVERIES_POSTAL_CODE = '';
process.env.LAPOSTE_API_KEY = '';

async function run(): Promise<void> {
    // guessCarrier
    assert.strictEqual(guessCarrier('1Z999AA10123456784'), 'ups');
    assert.strictEqual(guessCarrier('6A12345678901'), 'colissimo');
    assert.strictEqual(guessCarrier('510053223819'), 'colisprive');
    assert.strictEqual(guessCarrier('ABC123XYZ'), 'inconnu');

    // upsert depuis un mail : création + transition initiale
    {
        const p = upsertFromMail(
            {
                tracking: '510053223819',
                carrier: 'colisprive',
                url: 'https://x',
            },
            { status: 'shipped', label: 'AMAZON', estimatedDate: '2026-09-05' },
        );
        assert.strictEqual(p.status, 'shipped');
        assert.strictEqual(p.label, 'AMAZON');
        const trs = takeTransitions();
        assert.strictEqual(trs.length, 1);
        assert.strictEqual(trs[0].to, 'shipped');
        assert.strictEqual(takeTransitions().length, 0, 'file vidée');
    }

    // Progression : shipped → out_for_delivery émet une transition
    {
        upsertFromMail(
            { tracking: '510053223819', carrier: 'colisprive' },
            { status: 'out_for_delivery' },
        );
        const trs = takeTransitions();
        assert.strictEqual(trs.length, 1);
        assert.strictEqual(trs[0].from, 'shipped');
        assert.strictEqual(trs[0].to, 'out_for_delivery');
    }

    // Un mail relu ne fait PAS reculer le statut (pas de transition)
    {
        upsertFromMail(
            { tracking: '510053223819', carrier: 'colisprive' },
            { status: 'shipped' },
        );
        assert.strictEqual(takeTransitions().length, 0);
        assert.strictEqual(listParcels()[0].status, 'out_for_delivery');
    }

    // Même statut ré-upserté : pas de transition (dédup naturelle)
    {
        upsertFromMail(
            { tracking: '510053223819', carrier: 'colisprive' },
            { status: 'out_for_delivery' },
        );
        assert.strictEqual(takeTransitions().length, 0);
    }

    // Ajout manuel (transporteur sans provider → pas de réseau)
    {
        const p = await addManual({ tracking: '12345678', label: 'Vinted' });
        assert.strictEqual(p.carrier, 'mondialrelay');
        assert.strictEqual(p.source, 'manuel');
        assert.strictEqual(listParcels().length, 2);
    }

    // Numéro invalide refusé
    await assert.rejects(() => addManual({ tracking: '!!' }));

    // Suppression
    {
        const id = listParcels().find((p) => p.source === 'manuel')!.id;
        assert.strictEqual(removeParcel(id), true);
        assert.strictEqual(removeParcel(id), false);
        assert.strictEqual(listParcels().length, 1);
    }

    console.log('All tracker tests passed');
}

run()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
