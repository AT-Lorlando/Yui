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

    console.log('All situation tests passed');
}

run();
