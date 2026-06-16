import assert from 'assert';
import { geofenceTransition } from './presence';

function run(): void {
    assert.deepStrictEqual(geofenceTransition('away', 'enter'), {
        next: 'home',
        event: 'arrival',
    });
    assert.deepStrictEqual(geofenceTransition('unknown', 'enter'), {
        next: 'home',
        event: 'arrival',
    });
    assert.deepStrictEqual(geofenceTransition('home', 'enter'), {
        next: 'home',
        event: null,
    });
    assert.deepStrictEqual(geofenceTransition('home', 'exit'), {
        next: 'away',
        event: 'departure',
    });
    assert.deepStrictEqual(geofenceTransition('away', 'exit'), {
        next: 'away',
        event: null,
    });
    assert.deepStrictEqual(geofenceTransition('home', 'wat'), {
        next: 'home',
        event: null,
    });
    console.log('All presence geofence tests passed');
}

run();
