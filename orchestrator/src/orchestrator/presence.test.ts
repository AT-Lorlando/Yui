import assert from 'assert';
import { geofenceShouldTriggerArrival } from './presence';

function run(): void {
    assert.strictEqual(geofenceShouldTriggerArrival('away', 'enter'), true);
    assert.strictEqual(geofenceShouldTriggerArrival('home', 'enter'), false);
    assert.strictEqual(geofenceShouldTriggerArrival('unknown', 'enter'), false);
    assert.strictEqual(geofenceShouldTriggerArrival('away', 'exit'), false);
    console.log('All presence geofence tests passed');
}

run();
