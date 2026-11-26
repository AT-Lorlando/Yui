import assert from 'assert';
import type { AgendaEvent } from '../agendaSecretary';
import {
    DEFAULT_SCHEDULE,
    addDays,
    dayPlan,
    isLeaveEvent,
    localYmd,
    normalizeException,
    normalizeTemplate,
    type Schedule,
} from './dayPlan';

function ev(p: Partial<AgendaEvent>): AgendaEvent {
    return {
        id: 'e',
        title: 'Évènement',
        date: '2026-11-26',
        endDate: null,
        start: null,
        allDay: false,
        location: null,
        description: null,
        durationMin: null,
        attendees: [],
        calendar: 'Calendrier',
        ...p,
    };
}

function withWeek(day: string, t: Schedule['week'][string]): Schedule {
    return { week: { ...DEFAULT_SCHEDULE.week, [day]: t }, exceptions: [] };
}

function run() {
    // normalizeTemplate
    assert.deepStrictEqual(normalizeTemplate({ mode: 'onsite' }), {
        mode: 'onsite',
        leave: '08:30',
        back: '18:30',
    });
    assert.deepStrictEqual(
        normalizeTemplate({ mode: 'remote', leave: '08:00' }),
        { mode: 'remote' },
    );
    assert.throws(() => normalizeTemplate({ mode: 'x' }));
    assert.throws(() =>
        normalizeTemplate({ mode: 'onsite', leave: '19:00', back: '18:00' }),
    );
    assert.throws(() => normalizeTemplate({ mode: 'onsite', leave: '8h' }));

    assert.throws(() =>
        normalizeException({ date: '2026-02-30', mode: 'off' }),
    );
    assert.strictEqual(
        normalizeException({
            date: '2026-12-03',
            mode: 'off',
            note: 'x'.repeat(200),
        }).note?.length,
        120,
    );

    // semaine type
    assert.deepStrictEqual(dayPlan('2026-11-26', DEFAULT_SCHEDULE, []), {
        date: '2026-11-26',
        mode: 'remote',
        reason: 'semaine',
    });
    const thuOnsite = withWeek('4', {
        mode: 'onsite',
        leave: '08:15',
        back: '18:30',
    });
    const p = dayPlan('2026-11-26', thuOnsite, []);
    assert.strictEqual(p.mode, 'onsite');
    assert.strictEqual(p.reason, 'semaine');
    assert.strictEqual(p.leave, '08:15');

    // férié
    assert.deepStrictEqual(dayPlan('2026-11-11', DEFAULT_SCHEDULE, []), {
        date: '2026-11-11',
        mode: 'remote',
        reason: 'ferie',
        label: 'Armistice',
    });

    // exception sur férié : l'exception gagne
    const exc: Schedule = {
        ...DEFAULT_SCHEDULE,
        exceptions: [{ date: '2026-11-11', mode: 'onsite' }],
    };
    const pe = dayPlan('2026-11-11', exc, []);
    assert.strictEqual(pe.reason, 'exception');
    assert.strictEqual(pe.mode, 'onsite');
    assert.strictEqual(pe.leave, '08:30');

    // exception sur congé : l'exception gagne aussi
    const leave = ev({
        allDay: true,
        date: '2026-07-28',
        endDate: '2026-08-03',
        title: 'Congés été',
    });
    const excLeave: Schedule = {
        ...DEFAULT_SCHEDULE,
        exceptions: [{ date: '2026-07-31', mode: 'off' }],
    };
    assert.strictEqual(
        dayPlan('2026-07-31', excLeave, [leave]).reason,
        'exception',
    );

    // congé multi-jours
    for (const d of ['2026-07-28', '2026-07-31', '2026-08-03']) {
        const pl = dayPlan(d, thuOnsite, [leave]);
        assert.strictEqual(pl.reason, 'conge', d);
        assert.strictEqual(pl.mode, 'remote', d);
        assert.strictEqual(pl.label, 'Congés été', d);
    }
    assert.strictEqual(
        dayPlan('2026-08-04', DEFAULT_SCHEDULE, [leave]).reason,
        'semaine',
    );

    // congé horaire
    assert.strictEqual(
        isLeaveEvent(
            ev({ start: '09:00', durationMin: 480, title: 'OOF' }),
            '2026-11-26',
        ),
        true,
    );
    assert.strictEqual(
        isLeaveEvent(
            ev({ start: '09:00', durationMin: 120, title: 'OOF' }),
            '2026-11-26',
        ),
        false,
    );
    assert.strictEqual(
        isLeaveEvent(
            ev({ start: '09:00', durationMin: 480, title: 'Out of Office' }),
            '2026-11-27',
        ),
        false,
    );

    // congé horaire sur plusieurs jours (OOF Outlook lun 09:00 → ven 18:00)
    const oof = ev({
        date: '2026-11-30',
        start: '09:00',
        durationMin: 4 * 1440 + 540,
        title: 'Congés',
    });
    for (const d of ['2026-11-30', '2026-12-01', '2026-12-03', '2026-12-04'])
        assert.strictEqual(isLeaveEvent(oof, d), true, d);
    assert.strictEqual(isLeaveEvent(oof, '2026-12-05'), false);
    assert.strictEqual(isLeaveEvent(oof, '2026-11-29'), false);
    // fin d'après-midi seulement : moins de 6 h ce jour-là
    const lateStart = ev({
        date: '2026-11-30',
        start: '20:00',
        durationMin: 1440 + 120,
        title: 'Congés',
    });
    assert.strictEqual(isLeaveEvent(lateStart, '2026-11-30'), false);
    assert.strictEqual(isLeaveEvent(lateStart, '2026-12-01'), true);

    // vacances scolaires : jamais un congé perso
    assert.strictEqual(
        isLeaveEvent(
            ev({
                allDay: true,
                title: 'Vacances de Noël',
                calendar: 'Vacances scolaires Zone C',
            }),
            '2026-11-26',
        ),
        false,
    );
    assert.strictEqual(
        isLeaveEvent(
            ev({ allDay: true, title: 'Vacances scolaires' }),
            '2026-11-26',
        ),
        false,
    );

    // agenda Famille exclu
    assert.strictEqual(
        isLeaveEvent(
            ev({ allDay: true, title: 'Vacances', calendar: 'Famille' }),
            '2026-11-26',
        ),
        false,
    );
    // mot-clé dans un titre de réunion courte
    assert.strictEqual(
        isLeaveEvent(
            ev({
                start: '10:00',
                durationMin: 30,
                title: 'Réunion absence de Paul',
            }),
            '2026-11-26',
        ),
        false,
    );
    // accents et casse ignorés, mot entier
    assert.strictEqual(
        isLeaveEvent(ev({ allDay: true, title: 'CONGE' }), '2026-11-26'),
        true,
    );
    assert.strictEqual(
        isLeaveEvent(ev({ allDay: true, title: 'Dirty rtts' }), '2026-11-26'),
        false,
    );

    // fin d'année
    assert.strictEqual(addDays('2026-12-28', 4), '2027-01-01');
    assert.strictEqual(
        dayPlan('2027-01-01', DEFAULT_SCHEDULE, []).reason,
        'ferie',
    );

    // minuit local
    assert.strictEqual(localYmd(new Date(2026, 10, 26, 23, 30)), '2026-11-26');
    assert.strictEqual(localYmd(new Date(2026, 10, 27, 0, 10)), '2026-11-27');

    console.log('dayPlan.test.ts ok');
}
run();
