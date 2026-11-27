import assert from 'assert';
import type { AgendaEvent } from '../../agendaSecretary';
import {
    hourNotif,
    hourSpoken,
    morningBrief,
    numberFr,
    numberFrFem,
} from './format';

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

// ── nombres et heures ──
assert.strictEqual(hourNotif('14:00'), '14h');
assert.strictEqual(hourNotif('14:30'), '14h30');
assert.strictEqual(hourNotif('09:05'), '9h05');
assert.strictEqual(hourSpoken('14:30'), 'quatorze heures trente');
assert.strictEqual(hourSpoken('14:00'), 'quatorze heures');
assert.strictEqual(hourSpoken('09:05'), 'neuf heures cinq');
assert.strictEqual(hourSpoken('12:00'), 'midi');
assert.strictEqual(hourSpoken('00:15'), 'minuit quinze');
assert.strictEqual(hourSpoken('00:00'), 'minuit');
assert.strictEqual(hourSpoken('01:00'), 'une heure');
assert.strictEqual(hourSpoken('21:00'), 'vingt et une heures');
assert.strictEqual(hourSpoken('21:30'), 'vingt et une heures trente');
assert.strictEqual(numberFr(0), 'zéro');
assert.strictEqual(numberFr(17), 'dix-sept');
assert.strictEqual(numberFr(21), 'vingt et un');
assert.strictEqual(numberFr(31), 'trente et un');
assert.strictEqual(numberFr(45), 'quarante-cinq');
assert.strictEqual(numberFr(59), 'cinquante-neuf');
// minutes au féminin
assert.strictEqual(numberFrFem(1), 'une');
assert.strictEqual(numberFrFem(21), 'vingt et une');
assert.strictEqual(numberFrFem(31), 'trente et une');
assert.strictEqual(numberFrFem(51), 'cinquante et une');
assert.strictEqual(numberFrFem(45), 'quarante-cinq');
assert.strictEqual(numberFrFem(11), 'onze');
assert.strictEqual(hourSpoken('09:01'), 'neuf heures une');
assert.strictEqual(hourSpoken('10:21'), 'dix heures vingt et une');
assert.strictEqual(hourSpoken('21:31'), 'vingt et une heures trente et une');
assert.strictEqual(hourSpoken('12:41'), 'midi quarante et une');

// ── exemple de Jérémy ──
{
    const r = morningBrief(DAY, [
        ev({
            title: 'Entrevue avec CadresEnMission',
            start: '14:30',
            location: 'Microsoft Teams',
        }),
        ev({
            title: 'Entretien avec K-You',
            start: '14:00',
            location: 'Microsoft Teams',
        }),
    ]);
    assert.strictEqual(
        r.notif,
        '2 réunions ajd — 14h : Entretien avec K-You (visio) · 14h30 : Entrevue avec CadresEnMission (visio)',
    );
    assert.strictEqual(
        r.spoken,
        "Deux réunions aujourd'hui. Quatorze heures, Entretien avec K-You, en visio. Quatorze heures trente, Entrevue avec CadresEnMission, en visio.",
    );
}

// ── rdv sur site ──
{
    const r = morningBrief(DAY, [ev({ title: 'Kiné', start: '09:00' })]);
    assert.strictEqual(r.notif, '1 rdv ajd — 9h : Kiné (sur site)');
    assert.strictEqual(
        r.spoken,
        "Un rendez-vous aujourd'hui. Neuf heures, Kiné, sur site.",
    );
}

// ── une réunion, sans étiquette ──
{
    const r = morningBrief(DAY, [ev({ title: 'Point Koya', start: '10:00' })]);
    assert.strictEqual(r.notif, '1 réunion ajd — 10h : Point Koya');
    assert.strictEqual(
        r.spoken,
        "Une réunion aujourd'hui. Dix heures, Point Koya.",
    );
}

// ── journée entière seule ──
{
    const r = morningBrief(DAY, [
        ev({ title: 'Facturation Koya', start: null, allDay: true }),
    ]);
    assert.strictEqual(
        r.notif,
        "Rien à l'agenda ajd · ajd aussi : Facturation Koya",
    );
    assert.strictEqual(
        r.spoken,
        "Rien à l'agenda aujourd'hui. Aujourd'hui aussi : Facturation Koya.",
    );
}

// ── journée entière + horaire ──
{
    const r = morningBrief(DAY, [
        ev({ title: 'Point Koya', start: '10:00' }),
        ev({ title: 'A', start: null, allDay: true }),
        ev({ title: 'B', start: null, allDay: true }),
    ]);
    assert.strictEqual(
        r.notif,
        '1 réunion ajd — 10h : Point Koya · ajd aussi : A, B',
    );
    assert.strictEqual(
        r.spoken,
        "Une réunion aujourd'hui. Dix heures, Point Koya. Aujourd'hui aussi : A, B.",
    );
}

// ── journée entière multi-jour couvrant la date ──
{
    const r = morningBrief(DAY, [
        ev({
            title: 'Séminaire',
            date: '2026-11-26',
            endDate: '2026-11-28',
            start: null,
            allDay: true,
        }),
    ]);
    assert.ok(r.notif.includes('ajd aussi : Séminaire'));
}

// ── rien ──
{
    const r = morningBrief(DAY, []);
    assert.strictEqual(r.notif, "Rien à l'agenda ajd");
    assert.strictEqual(r.spoken, "Rien à l'agenda aujourd'hui.");
}

// ── exclusions : numéros de semaine, férié, lendemain ──
{
    const r = morningBrief(DAY, [
        ev({
            title: 'Semaine 48',
            calendar: 'Numéros de semaine',
            start: null,
            allDay: true,
        }),
        ev({
            title: 'Noël',
            calendar: 'Jours fériés en France',
            start: null,
            allDay: true,
        }),
        ev({ title: 'Demain', date: '2026-11-28' }),
    ]);
    assert.strictEqual(r.notif, "Rien à l'agenda ajd");
}

// ── plus de 6 horaires ──
{
    const events = Array.from({ length: 8 }, (_, i) =>
        ev({ title: `R${i}`, start: `0${i + 1}:00` }),
    );
    const r = morningBrief(DAY, events);
    assert.ok(r.notif.startsWith('8 réunions ajd — 1h : R0'));
    assert.ok(r.notif.endsWith(' · +2'));
    assert.ok(!r.notif.includes('R6'));
    assert.ok(r.spoken.startsWith("Huit réunions aujourd'hui."));
    assert.ok(r.spoken.endsWith(' Et deux autres.'));
}

// ── exactement 7 horaires ──
{
    const events = Array.from({ length: 7 }, (_, i) =>
        ev({ title: `R${i}`, start: `0${i + 1}:00` }),
    );
    const r = morningBrief(DAY, events);
    assert.ok(r.notif.endsWith(' · +1'));
    assert.ok(r.spoken.endsWith(' Et un autre.'));
}

console.log('reminders/format OK');
