import assert from 'assert';
import { evaluatePresenceTransition } from './presence';
import type { CandidateEvent } from '../types';

async function run(): Promise<void> {
    // départ + porte déverrouillée → alerte urgente
    {
        const handler = async () => [
            { name: 'Entrée', state: { stateName: 'unlocked' } },
            { name: 'Garage', state: { stateName: 'locked' } },
        ];
        const events = await evaluatePresenceTransition(
            'home',
            'away',
            handler,
        );
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].subject, 'left-unlocked');
        assert.strictEqual(events[0].importance, 'urgent');
        assert.ok(events[0].facts.includes('Entrée'));
    }

    // départ + tout verrouillé → rien
    {
        const handler = async () => [
            { name: 'Entrée', state: { stateName: 'locked' } },
        ];
        const events = await evaluatePresenceTransition(
            'home',
            'away',
            handler,
        );
        assert.strictEqual(events.length, 0);
    }

    // arrivée → message de bienvenue (info)
    {
        const handler = async () => [];
        const events = await evaluatePresenceTransition(
            'away',
            'home',
            handler,
        );
        assert.deepStrictEqual(
            events.map((e: CandidateEvent) => e.subject),
            ['welcome-back'],
        );
    }

    console.log('All presence-watcher tests passed');
}

run();
