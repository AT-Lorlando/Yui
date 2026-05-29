import assert from 'assert';
import { passesThreshold, isQuietHours, hmToMinutes } from './gates';

function run(): void {
    // seuil selon le curseur
    assert.strictEqual(passesThreshold('info', 'bavard'), true);
    assert.strictEqual(passesThreshold('info', 'normal'), false);
    assert.strictEqual(passesThreshold('utile', 'normal'), true);
    assert.strictEqual(passesThreshold('utile', 'discret'), false);
    assert.strictEqual(passesThreshold('urgent', 'discret'), true);
    assert.strictEqual(passesThreshold('critique', 'discret'), true);

    // conversion HH:MM
    assert.strictEqual(hmToMinutes('07:30'), 450);
    assert.strictEqual(hmToMinutes('00:00'), 0);

    // heures de silence qui passent minuit (23:00 → 07:00)
    const q = { start: '23:00', end: '07:00' };
    assert.strictEqual(isQuietHours(new Date('2026-05-29T23:30:00'), q), true);
    assert.strictEqual(isQuietHours(new Date('2026-05-29T03:00:00'), q), true);
    assert.strictEqual(isQuietHours(new Date('2026-05-29T07:00:00'), q), false);
    assert.strictEqual(isQuietHours(new Date('2026-05-29T14:00:00'), q), false);

    console.log('All gates tests passed');
}

run();
