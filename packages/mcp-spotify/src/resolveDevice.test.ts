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
    assert.strictEqual(resolveSpeakerDevice(devices, 'Sono')?.id, '1');
    assert.strictEqual(resolveSpeakerDevice([], 'WiiM'), undefined);
    const two = [
        { id: 'a', name: 'A', type: 'AVR' },
        { id: 'b', name: 'B', type: 'AVR' },
    ] as any;
    assert.strictEqual(resolveSpeakerDevice(two, 'zzz'), undefined);
    console.log('All resolveDevice tests passed');
}

run();
