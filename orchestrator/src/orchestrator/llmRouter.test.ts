import assert from 'assert';
import { isComplexOrder } from './llmRouter';

function run(): void {
    // Commandes domotiques directes → simple (modèle local)
    assert.strictEqual(isComplexOrder('éteins le salon'), false);
    assert.strictEqual(isComplexOrder('mets du lofi'), false);
    assert.strictEqual(isComplexOrder('lance la scène cinéma'), false);
    // Raisonnement / rédaction → complexe
    assert.strictEqual(isComplexOrder('résume mes mails du jour'), true);
    assert.strictEqual(
        isComplexOrder('planifie ma semaine avec mon agenda'),
        true,
    );
    assert.strictEqual(
        isComplexOrder("pourquoi la lumière s'est allumée cette nuit ?"),
        true,
    );
    // Multi-étapes → complexe
    assert.strictEqual(
        isComplexOrder(
            'éteins le salon puis lance un timer, ensuite mets la télé',
        ),
        true,
    );
    // Longueur → complexe
    assert.strictEqual(isComplexOrder('a'.repeat(200)), true);
    console.log('All llmRouter tests passed');
}
run();
