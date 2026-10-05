import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProactiveJournal } from './journal';

async function run(): Promise<void> {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'yui-journal-')),
        'journal.json',
    );
    const j = new ProactiveJournal(file);
    for (const at of [100, 200, 300, 400]) {
        j.record({
            at,
            source: 's',
            subject: `x${at}`,
            channel: 'speak',
            message: 'm',
        });
    }
    assert.deepStrictEqual(
        j.list(50).map((e) => e.at),
        [400, 300, 200, 100],
    );
    // `before` est exclusif : strictement plus ancien.
    assert.deepStrictEqual(
        j.list(50, 300).map((e) => e.at),
        [200, 100],
    );
    assert.deepStrictEqual(
        j.list(1, 400).map((e) => e.at),
        [300],
    );
    assert.deepStrictEqual(j.list(50, 100), []);
    console.log('All journal tests passed');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
