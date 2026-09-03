import assert from 'assert';
import * as fs from 'fs';
import { dataPath } from '@yui/shared';
import { logActivity, readActivity } from './activityLog';

function run(): void {
    const file = dataPath('activity-log.json');
    const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
    try {
        fs.rmSync(file, { force: true });
        assert.deepStrictEqual(readActivity(), [], 'vide au départ');

        logActivity('scene', 'Mentalist');
        logActivity('presence', 'Départ annulé', 'téléphone vu sur le réseau');
        const entries = readActivity();
        assert.strictEqual(entries.length, 2);
        assert.strictEqual(
            entries[0].label,
            'Départ annulé',
            'plus récent en premier',
        );
        assert.strictEqual(entries[0].detail, 'téléphone vu sur le réseau');
        assert.strictEqual(entries[1].kind, 'scene');
        assert.ok(entries[0].ts >= entries[1].ts);

        assert.strictEqual(readActivity(1).length, 1, 'limit respectée');
    } finally {
        if (backup) fs.writeFileSync(file, backup);
        else fs.rmSync(file, { force: true });
    }
    console.log('All activityLog tests passed');
}
run();
