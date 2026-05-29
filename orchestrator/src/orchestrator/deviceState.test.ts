import assert from 'assert';
import {
    formatLights,
    formatDoors,
    formatPlayback,
    formatTv,
    formatCovers,
    buildDeviceStateSnapshot,
} from './deviceState';

function run(): void {
    assert.strictEqual(
        formatLights([
            { name: 'Salon', state: { on: true, brightness: 203 } },
            { name: 'Cuisine', state: { on: false } },
            { name: 'Couloir', state: { on: true, reachable: false } },
        ]),
        'Lumières : Salon allumé (80%), Cuisine éteint, Couloir injoignable',
    );
    assert.strictEqual(formatLights([]), null);
    assert.strictEqual(formatLights('x'), null);

    assert.strictEqual(
        formatDoors([
            { name: 'Entrée', state: { stateName: 'locked' } },
            { name: 'Garage', state: { stateName: 'unlocked' } },
        ]),
        'Serrures : Entrée verrouillée, Garage déverrouillée',
    );

    assert.strictEqual(
        formatPlayback({ playing: false }),
        'Lecture : rien en cours',
    );
    assert.strictEqual(
        formatPlayback({
            playing: true,
            track: 'Song',
            artist: 'Artist',
            device: { name: 'WiiM', volume: 25 },
        }),
        'Lecture : « Song » — Artist (vol 25) sur WiiM',
    );

    assert.strictEqual(formatTv({ power: 'on' }), 'TV : allumée');
    assert.strictEqual(formatTv({ power: 'off' }), 'TV : éteinte');
    assert.strictEqual(formatTv({}), null);

    assert.strictEqual(
        formatCovers([
            { name: 'Salon', position: 0 },
            { name: 'Chambre', position: 100 },
            { name: 'Bureau', position: 40 },
            { name: 'Garage', position: null },
        ]),
        'Volets : Salon ouvert, Chambre fermé, Bureau 40% fermé, Garage (position inconnue)',
    );

    assert.strictEqual(
        buildDeviceStateSnapshot([
            'Lumières : Salon allumé',
            null,
            'TV : éteinte',
        ]),
        'Lumières : Salon allumé\nTV : éteinte',
    );
    assert.strictEqual(buildDeviceStateSnapshot([null, null]), '');

    console.log('All deviceState format tests passed');
}

run();
