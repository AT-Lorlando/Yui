import assert from 'assert';
import { summarizeSituation } from './situation';

function run(): void {
    const s = {
        at: new Date('2026-09-25T10:00:00').getTime(),
        presence: 'home',
        lightsOn: [],
        doorLocked: true,
        agenda: [],
        parcels: [],
        mailActions: [],
        musicPlaying: false,
        sections: {
            weather: [{ label: 'Météo', value: '20°C à Toulouse' }],
            koya: [
                { label: 'Alertes', value: '2 ouvertes' },
                { label: 'Disque nas', value: '94 %' },
            ],
            // Une section vide ne doit rien imprimer (connecteur sans état).
            empty: [],
        },
    };
    const txt = summarizeSituation(s as never);
    assert.ok(
        txt.includes('Météo 20°C à Toulouse'),
        `section météo absente du résumé : ${txt}`,
    );
    assert.ok(
        txt.includes('koya : Alertes 2 ouvertes ; Disque nas 94 %'),
        `section koya mal rendue : ${txt}`,
    );
    assert.ok(!txt.includes('empty'), 'la section vide ne doit pas apparaître');

    // Sans sections : le résumé historique est inchangé.
    const bare = summarizeSituation({ ...s, sections: undefined } as never);
    assert.ok(bare.includes('Jérémy est à la maison'));
    assert.ok(!bare.includes('koya'));

    // Les champs historiques ne sont plus dupliqués quand la section du
    // connecteur porte la même information.
    const full = {
        ...s,
        agenda: [
            {
                title: 'Kinéis',
                date: '2026-09-25',
                start: '10:20',
                location: null,
            },
        ],
        parcels: [{ label: 'Casque', status: 'transit' }],
        mailActions: ['Facture'],
    };
    const legacy = summarizeSituation({ ...full, sections: {} } as never);
    assert.ok(legacy.includes('Agenda 24h : Kinéis à 10:20'), legacy);
    assert.ok(legacy.includes('Colis : Casque (transit)'), legacy);
    assert.ok(legacy.includes('Mails à traiter : Facture'), legacy);

    const sectioned = summarizeSituation({
        ...full,
        sections: {
            calendar: [{ label: 'Agenda', value: 'Kinéis à 10:20' }],
            deliveries: [{ label: 'Colis', value: 'Casque : transit' }],
            mail: [{ label: 'À traiter', value: 'Facture' }],
        },
    } as never);
    assert.ok(!sectioned.includes('Agenda 24h'), sectioned);
    assert.ok(!sectioned.includes('Colis : Casque (transit)'), sectioned);
    assert.ok(!sectioned.includes('Mails à traiter'), sectioned);
    assert.ok(
        sectioned.includes('calendar : Agenda Kinéis à 10:20'),
        sectioned,
    );

    // Section présente mais vide : la ligne historique reste (rien ne la remplace).
    const emptySection = summarizeSituation({
        ...full,
        sections: { calendar: [], deliveries: [], mail: [] },
    } as never);
    assert.ok(emptySection.includes('Agenda 24h'), emptySection);

    console.log('All situation tests passed');
}

run();
