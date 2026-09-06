import assert from 'assert';
import { resolveSpeakerDevice } from './resolveDevice';

function run(): void {
    const devices = [
        { id: '1', name: 'WiiM Ultra-65B6', type: 'AVR' },
        { id: '2', name: 'iPhone de Jérémy', type: 'Smartphone' },
    ] as any;
    assert.strictEqual(
        resolveSpeakerDevice(devices, 'wiim ultra-65b6')?.id,
        '1',
    );
    assert.strictEqual(resolveSpeakerDevice(devices, 'WiiM')?.id, '1');
    // Repli AVR : uniquement sur demande explicite (enceinte par défaut).
    assert.strictEqual(
        resolveSpeakerDevice(devices, 'Sono', { avrFallback: true })?.id,
        '1',
    );
    // Sans repli, un nom inconnu ne doit JAMAIS capturer l'AVR — sinon
    // « Google Home » jouait sur la Sono et le réveil Cast ne courait pas.
    assert.strictEqual(resolveSpeakerDevice(devices, 'Sono'), undefined);
    assert.strictEqual(resolveSpeakerDevice(devices, 'Google Home'), undefined);
    assert.strictEqual(
        resolveSpeakerDevice(devices, 'Google Home', { avrFallback: true })?.id,
        '1',
        'avec repli explicite, comportement historique conservé',
    );
    assert.strictEqual(resolveSpeakerDevice([], 'WiiM'), undefined);
    const two = [
        { id: 'a', name: 'A', type: 'AVR' },
        { id: 'b', name: 'B', type: 'AVR' },
    ] as any;
    assert.strictEqual(
        resolveSpeakerDevice(two, 'zzz', { avrFallback: true }),
        undefined,
    );
    console.log('All resolveDevice tests passed');
}

run();
