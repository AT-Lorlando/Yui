import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectorState } from './connectorState';

async function run(): Promise<void> {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'yui-cs-')),
        'weather.json',
    );
    const s = new ConnectorState(file);
    assert.strictEqual(s.get('lastPoll', 0), 0);
    s.set('lastPoll', 42);
    s.set('seen', ['a', 'b']);
    assert.strictEqual(s.get('lastPoll', 0), 42);
    const s2 = new ConnectorState(file);
    assert.deepStrictEqual(s2.get('seen', []), ['a', 'b'], 'persisté');
    // Fichier corrompu → on repart vide, sans lever.
    fs.writeFileSync(file, '{oops');
    assert.strictEqual(new ConnectorState(file).get('lastPoll', -1), -1);
    // Mémoire seule.
    const m = new ConnectorState();
    m.set('k', 1);
    assert.strictEqual(m.get('k', 0), 1);
    console.log('All connectorState tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
