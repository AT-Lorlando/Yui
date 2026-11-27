import assert from 'assert';
import type { AgendaEvent } from '../../agendaSecretary';
import { eventsOn, feedOf, isNight, minutesOf } from './feeds';

const DAY = '2026-11-27';

function ev(p: Partial<AgendaEvent> & { title: string }): AgendaEvent {
    return {
        id: p.title,
        date: DAY,
        endDate: null,
        start: '10:00',
        allDay: false,
        location: null,
        description: null,
        durationMin: 60,
        attendees: [],
        ...p,
    };
}

// ── feedOf ──
assert.strictEqual(feedOf(ev({ title: 'a', calendar: 'Famille' })), 'family');
assert.strictEqual(
    feedOf(ev({ title: 'a', calendar: 'Jours fériés en France' })),
    'excluded',
);
assert.strictEqual(
    feedOf(ev({ title: 'a', calendar: 'Numéros de semaine' })),
    'excluded',
);
assert.strictEqual(feedOf(ev({ title: 'a', calendar: 'Calendrier' })), 'main');
assert.strictEqual(feedOf(ev({ title: 'a' })), 'main');

// ── eventsOn ──
{
    const r = eventsOn(DAY, [
        ev({ title: 'Tard', start: '15:00' }),
        ev({ title: 'Tôt', start: '09:00' }),
        ev({
            title: 'Séminaire',
            date: '2026-11-26',
            endDate: '2026-11-28',
            start: null,
            allDay: true,
        }),
        ev({
            title: 'Férié',
            calendar: 'Jours fériés en France',
            start: null,
            allDay: true,
        }),
        ev({ title: 'Demain', date: '2026-11-28' }),
        ev({ title: 'Hier', date: '2026-11-26' }),
    ]);
    assert.deepStrictEqual(
        r.map((e) => e.title),
        ['Séminaire', 'Tôt', 'Tard'],
    );
}

// ── minutesOf ──
assert.strictEqual(minutesOf('00:00'), 0);
assert.strictEqual(minutesOf('09:30'), 570);

// ── isNight ──
{
    const quiet = { start: '23:00', end: '07:00' };
    const at = (h: number, m: number) => new Date(2026, 10, 27, h, m, 0);
    assert.strictEqual(isNight(at(6, 40), quiet, at(6, 30).getTime()), false);
    assert.strictEqual(isNight(at(6, 40), quiet, null), true);
    assert.strictEqual(isNight(at(6, 20), quiet, at(6, 30).getTime()), true);
    assert.strictEqual(isNight(at(23, 30), quiet, null), true);
    assert.strictEqual(isNight(at(12, 0), quiet, null), false);
    // après le réveil, le soir même reste la nuit
    assert.strictEqual(isNight(at(23, 30), quiet, at(6, 30).getTime()), true);
    // réveil d'un autre jour : ignoré
    assert.strictEqual(
        isNight(at(6, 40), quiet, new Date(2026, 10, 26, 6, 30).getTime()),
        true,
    );
}

console.log('reminders/feeds OK');
