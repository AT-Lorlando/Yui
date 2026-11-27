import assert from 'assert';
import type { AgendaEvent } from '../../agendaSecretary';
import {
    departText,
    eveText,
    imminentText,
    mergeTexts,
    morningText,
    parcelText,
    returnText,
} from './templates';
import type { ParcelInfo } from './types';

const DAY = '2026-11-27';
const TOMORROW = '2026-11-28';

function ev(p: Partial<AgendaEvent> & { title: string }): AgendaEvent {
    return {
        id: p.title,
        date: TOMORROW,
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

const parcel = (p: Partial<ParcelInfo> = {}): ParcelInfo => ({
    id: 'p1',
    label: 'clavier',
    status: 'in_transit',
    estimatedDate: TOMORROW,
    updatedAt: 0,
    ...p,
});

// ── veille ──
{
    const r = eveText(
        TOMORROW,
        [
            ev({
                title: 'Point Koya',
                start: '14:00',
                location: 'Microsoft Teams',
            }),
            ev({ title: 'Kiné', start: '09:00', location: '12 rue X' }),
        ],
        [parcel()],
        { count: 0, names: [] },
    );
    assert.strictEqual(
        r.notif,
        'Demain : 9h Kiné (12 rue X) · 14h Point Koya (visio) · Colis « clavier » attendu',
    );
    assert.strictEqual(
        r.spoken,
        'Demain : neuf heures, Kiné, 12 rue X. Quatorze heures, Point Koya, en visio. Colis « clavier » attendu.',
    );
}
{
    const r = eveText(
        TOMORROW,
        [ev({ title: 'Facturation', start: null, allDay: true })],
        [],
        { count: 2, names: ['URSSAF', 'Malt'] },
    );
    assert.strictEqual(
        r.notif,
        'Demain : Facturation (journée) · 2 mails à traiter : URSSAF, Malt',
    );
    assert.strictEqual(
        r.spoken,
        'Demain : Facturation, toute la journée. Deux mails à traiter : URSSAF, Malt.',
    );
}
{
    // colis d'un autre jour ignoré, agenda vide
    const r = eveText(TOMORROW, [], [parcel({ estimatedDate: DAY })], {
        count: 0,
        names: [],
    });
    assert.strictEqual(r.notif, "Demain : rien à l'agenda");
    assert.strictEqual(r.spoken, "Demain : rien à l'agenda.");
}

{
    // compte complet des mails, au plus trois noms
    const r = eveText(
        TOMORROW,
        [ev({ title: 'Kiné', start: '09:00', location: '12 rue X' })],
        [],
        { count: 5, names: ['URSSAF', 'Malt', 'Qonto', 'Free'] },
    );
    assert.ok(
        r.notif.endsWith('5 mails à traiter : URSSAF, Malt, Qonto'),
        r.notif,
    );
    assert.ok(
        r.spoken.endsWith('Cinq mails à traiter : URSSAF, Malt, Qonto.'),
        r.spoken,
    );
    const one = morningText(DAY, [], { count: 1, names: ['Malt'] }, [], []);
    assert.ok(one.notif.endsWith('1 mail à traiter : Malt'), one.notif);
    assert.ok(one.spoken.endsWith('Un mail à traiter : Malt.'), one.spoken);
    // mails sans expéditeur lisible : le compte seul
    const anon = morningText(DAY, [], { count: 2, names: [] }, [], []);
    assert.ok(anon.notif.endsWith('2 mails à traiter'), anon.notif);
    assert.ok(anon.spoken.endsWith('Deux mails à traiter.'), anon.spoken);
}

// ── imminent ──
{
    const r = imminentText(
        ev({ title: 'Entretien avec K-You', location: 'Microsoft Teams' }),
        10,
    );
    assert.strictEqual(r.notif, 'Dans 10 min : Entretien avec K-You (visio)');
    assert.strictEqual(
        r.spoken,
        'Dans dix minutes : Entretien avec K-You, en visio.',
    );
    const o = imminentText(ev({ title: 'Kiné', location: '12 rue X' }), 45);
    assert.strictEqual(o.notif, 'Dans 45 min : Kiné (12 rue X)');
    assert.strictEqual(
        o.spoken,
        'Dans quarante-cinq minutes : Kiné, 12 rue X.',
    );
    // minutes au féminin
    assert.strictEqual(
        imminentText(ev({ title: 'Kiné', location: '12 rue X' }), 21).spoken,
        'Dans vingt et une minutes : Kiné, 12 rue X.',
    );
    assert.ok(
        departText(null, null, 31).spoken.startsWith(
            'Départ dans trente et une minutes.',
        ),
    );
    assert.ok(
        departText(
            ev({ title: 'X', start: '09:01' }),
            null,
            15,
        ).spoken.includes('à neuf heures une,'),
    );
}

// ── départ ──
{
    const e = ev({
        title: 'Entrevue Airbus géo',
        start: '10:00',
        location: '3 av. Y',
    });
    const r = departText(e, 'pluie', 15);
    assert.strictEqual(
        r.notif,
        'Départ dans 15 min — 1er RDV 10h : Entrevue Airbus géo (sur site) · pluie',
    );
    assert.ok(r.spoken.startsWith('Départ dans quinze minutes.'));
    assert.ok(r.spoken.includes('dix heures'));
    assert.ok(r.spoken.includes('pluie'));
    const u = departText(ev({ title: 'Point Koya', start: '10:00' }), null, 15);
    assert.strictEqual(
        u.notif,
        'Départ dans 15 min — 1er RDV 10h : Point Koya (visio)',
    );
    assert.ok(u.spoken.includes('Point Koya, en visio'));
    assert.strictEqual(departText(null, null, 15).notif, 'Départ dans 15 min');
    assert.strictEqual(
        departText(null, 'pluie', 15).notif,
        'Départ dans 15 min · pluie',
    );
}

// ── colis ──
{
    const t = (status: string) => parcelText(parcel({ status }));
    assert.strictEqual(
        t('out_for_delivery').notif,
        "Colis « clavier » en livraison aujourd'hui",
    );
    assert.strictEqual(t('delivered').notif, 'Colis « clavier » livré');
    assert.strictEqual(t('pickup_ready').notif, 'Colis « clavier » à retirer');
    assert.strictEqual(
        t('problem').notif,
        'Colis « clavier » : problème de livraison',
    );
    for (const s of ['in_transit', 'shipped', 'announced', 'weird']) {
        assert.strictEqual(
            t(s).notif,
            "Colis « clavier » en cours d'acheminement",
        );
    }
    assert.strictEqual(t('delivered').spoken, 'Colis « clavier » livré.');
}

// ── matin ──
{
    const e = ev({
        title: 'Démo Aster',
        date: DAY,
        start: '11:00',
        location: 'Microsoft Teams',
    });
    const r = morningText(
        DAY,
        [e],
        { count: 2, names: ['URSSAF', 'Malt'] },
        ['rappeler le kiné'],
        [],
    );
    assert.strictEqual(
        r.notif,
        '1 réunion ajd — 11h : Démo Aster (visio) · 2 mails à traiter : URSSAF, Malt · post-it : rappeler le kiné',
    );
    assert.ok(r.spoken.includes('Deux mails à traiter : URSSAF, Malt.'));
    assert.ok(r.spoken.endsWith('Post-it : rappeler le kiné.'));
    const n = morningText(
        DAY,
        [],
        { count: 0, names: [] },
        [],
        ['Facture Koya'],
    );
    assert.strictEqual(n.notif, "Rien à l'agenda ajd · à noter : Facture Koya");
    assert.ok(n.spoken.endsWith('À noter : Facture Koya.'));
}

// ── retour / fusion ──
{
    const r = returnText(['Colis livré', 'Porte verrouillée']);
    assert.strictEqual(r.notif, 'Colis livré · Porte verrouillée');
    assert.strictEqual(r.spoken, 'Colis livré. Porte verrouillée.');
    const m = mergeTexts([
        { notif: 'A', spoken: 'a.' },
        { notif: 'B', spoken: 'b.' },
    ]);
    assert.strictEqual(m.notif, 'A\nB');
    assert.strictEqual(m.spoken, 'a. b.');
}

console.log('reminders/templates OK');
