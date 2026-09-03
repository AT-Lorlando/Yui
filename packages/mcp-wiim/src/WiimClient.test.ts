import assert from 'assert';
import { decodeHexMeta } from './WiimClient';

function run(): void {
    assert.strictEqual(
        decodeHexMeta('556E6B6E6F776E'),
        undefined,
        '"Unknown" hexifié → undefined (pas de titre)',
    );
    assert.strictEqual(
        decodeHexMeta('426F68656D69616E2052686170736F6479'),
        'Bohemian Rhapsody',
    );
    assert.strictEqual(decodeHexMeta('Pas du hex'), 'Pas du hex');
    assert.strictEqual(decodeHexMeta(''), undefined);
    assert.strictEqual(decodeHexMeta(undefined), undefined);
    console.log('All WiimClient tests passed');
}
run();
