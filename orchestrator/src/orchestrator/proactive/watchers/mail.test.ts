import assert from 'assert';
import { evaluateMail } from './mail';

async function run(): Promise<void> {
    const cfg = {
        pollMinutes: 15,
        query: 'is:important is:unread newer_than:1d',
    };

    // résultats → un événement, facts = texte renvoyé
    {
        const handler = async () =>
            '2 résultat(s) pour "is:important" :\n\n[1]\nDe: Banque\nObjet: Alerte';
        const events = await evaluateMail(handler, cfg);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].subject, 'important-mail');
        assert.ok(events[0].facts.includes('Banque'));
        assert.strictEqual(events[0].cooldownMs, 6 * 60 * 60_000);
    }

    // aucun mail → rien
    {
        const handler = async () =>
            'Aucun email pour la recherche : "is:important"';
        const events = await evaluateMail(handler, cfg);
        assert.strictEqual(events.length, 0);
    }

    // résultat très long → facts tronqués (borne le coût tokens du LLM)
    {
        const long = '10 résultat(s) :\n' + 'x'.repeat(5000);
        const handler = async () => long;
        const events = await evaluateMail(handler, cfg);
        assert.strictEqual(events.length, 1);
        assert.ok(events[0].facts.length < 1100);
        assert.ok(events[0].facts.endsWith('…'));
    }

    console.log('All mail tests passed');
}

run();
