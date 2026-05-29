import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { appendToHistory, loadHistory } from '../history';

function run(): void {
    const file = path.resolve(process.cwd(), 'data/automation-history.json');
    const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    try {
        appendToHistory({
            id: 'test-1',
            name: 'Test arrosage',
            action: { type: 'scene', sceneId: 's1' },
            tag: 'irrigation',
        });
        const top = loadHistory()[0];
        assert.strictEqual(top.id, 'test-1');
        assert.strictEqual(top.tag, 'irrigation');
        assert.strictEqual(typeof top.firedAt, 'number');
        console.log('All history-tag tests passed');
    } finally {
        if (backup !== null) fs.writeFileSync(file, backup);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
    }
}

run();
