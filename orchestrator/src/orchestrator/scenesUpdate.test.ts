// updateScene : null efface un champ (intro/floating), undefined le laisse.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-scenes-'));
process.env.YUI_DATA_DIR = tmp;

// Import après la variable d'env : le chemin de scenes.json est résolu au chargement.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createScene, updateScene, getScene } = require('./scenes');

const created = createScene({
    name: 'Test',
    icon: 'lucide:bolt',
    color: '#000',
    description: '',
    setup: [],
    state: [],
    intro: { effectId: 'intro-1' },
    floating: null as any, // null à la création → clé absente
});
assert.strictEqual(
    'floating' in getScene(created.id),
    false,
    'null ignoré à la création',
);
assert.deepStrictEqual(getScene(created.id).intro, { effectId: 'intro-1' });

updateScene(created.id, { name: 'Test 2' });
assert.deepStrictEqual(
    getScene(created.id).intro,
    { effectId: 'intro-1' },
    'undefined ne touche pas',
);

updateScene(created.id, { intro: null as any });
assert.strictEqual(
    'intro' in getScene(created.id),
    false,
    'null efface l’intro',
);
assert.strictEqual(getScene(created.id).name, 'Test 2');

updateScene(created.id, { floating: { effectId: 'f', target: 'Salon' } });
assert.deepStrictEqual(getScene(created.id).floating, {
    effectId: 'f',
    target: 'Salon',
});
updateScene(created.id, { floating: null as any });
assert.strictEqual(
    'floating' in getScene(created.id),
    false,
    'null efface la dérive',
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('scenesUpdate: ok');
