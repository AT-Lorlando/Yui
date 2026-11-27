// Identifiant d'instance : YUI_INSTANCE, sinon tiré une fois et persisté.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-instance-'));
process.env.YUI_DATA_DIR = tmp;
delete process.env.YUI_INSTANCE;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { instanceId } = require('./instance');
const file = path.join(tmp, 'state', 'instance-id.json');

// Sans env : tiré au hasard, persisté, stable
const a = instanceId();
assert.match(a, /^[a-z0-9-]{8,}$/);
assert.ok(fs.existsSync(file));
assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).id, a);
assert.strictEqual(instanceId(), a);

// Deux dossiers de données → deux ids différents
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-instance-'));
process.env.YUI_DATA_DIR = tmp2;
const b = instanceId();
assert.notStrictEqual(a, b);

// YUI_INSTANCE l'emporte (sans toucher au fichier)
process.env.YUI_INSTANCE = ' prod ';
assert.strictEqual(instanceId(), 'prod');
process.env.YUI_DATA_DIR = tmp;
assert.strictEqual(instanceId(), 'prod');
delete process.env.YUI_INSTANCE;
assert.strictEqual(instanceId(), a);

// Fichier corrompu : jamais remplacé en silence (un nouvel id orphelinerait
// tous les événements posés) → erreur
fs.writeFileSync(file, '{cassé');
assert.throws(() => instanceId());
assert.strictEqual(fs.readFileSync(file, 'utf8'), '{cassé');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
console.log('calendarRules/instance.test OK');
