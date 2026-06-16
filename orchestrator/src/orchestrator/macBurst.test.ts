import assert from 'assert';
import { burstStep } from './macBurst';

function run(): void {
    // present → join (peu importe le temps)
    assert.strictEqual(burstStep(true, 0, 300000), 'join');
    assert.strictEqual(burstStep(true, 999999, 300000), 'join');
    // absent + dans la fenêtre → continue
    assert.strictEqual(burstStep(false, 10000, 300000), 'continue');
    // routeur injoignable (null) + dans la fenêtre → continue
    assert.strictEqual(burstStep(null, 10000, 300000), 'continue');
    // absent + fenêtre atteinte → stop
    assert.strictEqual(burstStep(false, 300000, 300000), 'stop');
    assert.strictEqual(burstStep(null, 300001, 300000), 'stop');
    console.log('All macBurst tests passed');
}

run();
