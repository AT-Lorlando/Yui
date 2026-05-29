import assert from 'assert';
import { evaluateCalendar } from './calendar';

async function run(): Promise<void> {
    const now = new Date('2026-05-29T13:45:00'); // 13h45

    // rdv à 14h00 → dans 15 min → rappel (fenêtre 20 min)
    {
        const handler = async () => ({
            events: [
                { title: 'Réunion équipe', date: '2026-05-29', start: '14:00' },
            ],
        });
        const events = await evaluateCalendar(
            handler,
            { pollMinutes: 5, remindMinutesBefore: 20 },
            now,
        );
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].subject, 'event-2026-05-29-14:00');
        assert.ok(events[0].facts.includes('Réunion équipe'));
    }

    // rdv à 16h00 → trop loin → rien
    {
        const handler = async () => ({
            events: [
                { title: 'Plus tard', date: '2026-05-29', start: '16:00' },
            ],
        });
        const events = await evaluateCalendar(
            handler,
            { pollMinutes: 5, remindMinutesBefore: 20 },
            now,
        );
        assert.strictEqual(events.length, 0);
    }

    // forme { days: [{ events }] } aplatie
    {
        const handler = async () => ({
            days: [
                {
                    date: '2026-05-29',
                    events: [
                        {
                            title: 'Via days',
                            date: '2026-05-29',
                            start: '14:00',
                        },
                    ],
                },
            ],
        });
        const events = await evaluateCalendar(
            handler,
            { pollMinutes: 5, remindMinutesBefore: 20 },
            now,
        );
        assert.strictEqual(events.length, 1);
    }

    console.log('All calendar tests passed');
}

run();
