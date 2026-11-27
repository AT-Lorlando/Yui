// Persistance des règles d'agenda : data/config/calendar-rules.json.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-calendar-rules-'));
process.env.YUI_DATA_DIR = tmp;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require('./store');
const file = path.join(tmp, 'config', 'calendar-rules.json');
const today = '2026-11-27';

// Absent → []
assert.deepStrictEqual(store.readRules(), []);
assert.ok(!fs.existsSync(file));

// Création : normalisée et persistée
const r = store.createRule(
    { title: ' Facture ', kind: 'last-workday-month' },
    today,
);
assert.strictEqual(r.title, 'Facture');
assert.strictEqual(r.calendarId, 'primary');
assert.strictEqual(r.start, today);
assert.strictEqual(r.enabled, true);
assert.ok(r.id.startsWith('facture-'));
assert.ok(fs.existsSync(file));
assert.ok(!fs.existsSync(`${file}.tmp`));
assert.deepStrictEqual(store.readRules(), [r]);

// Une règle invalide n'est pas créée
assert.throws(() => store.createRule({ title: '', kind: 'yearly' }, today));
assert.strictEqual(store.readRules().length, 1);

// Mise à jour : id conservé, même si le corps en propose un autre
const u = store.updateRule(
    r.id,
    { id: 'autre', title: 'Facture client', kind: 'first-workday-month' },
    today,
);
assert.ok(u);
assert.strictEqual(u.id, r.id);
assert.strictEqual(u.title, 'Facture client');
assert.strictEqual(u.kind, 'first-workday-month');
assert.deepStrictEqual(store.readRules(), [u]);
assert.strictEqual(
    store.updateRule(
        'inconnue',
        { title: 'x', kind: 'yearly', month: 1, day: 1 },
        today,
    ),
    null,
);

// Sans `start`, la mise à jour garde celui de la règle
const s = store.createRule(
    { title: 'Loyer', kind: 'first-workday-month', start: '2026-12-01' },
    today,
);
assert.strictEqual(
    store.updateRule(
        s.id,
        { title: 'Loyer', kind: 'first-workday-month' },
        today,
    ).start,
    '2026-12-01',
);
assert.throws(() =>
    store.createRule(
        { id: s.id, title: 'Loyer', kind: 'yearly', month: 1, day: 1 },
        today,
    ),
);
assert.strictEqual(store.deleteRule(s.id), true);

// Suppression
assert.strictEqual(store.deleteRule('inconnue'), false);
assert.strictEqual(store.deleteRule(r.id), true);
assert.deepStrictEqual(store.readRules(), []);

// Entrée corrompue ignorée, les autres lues
fs.writeFileSync(
    file,
    JSON.stringify({
        rules: [
            {
                id: 'ok-1',
                title: 'Bon',
                kind: 'last-workday-month',
                start: today,
            },
            { id: 'ko-1', title: 'Mauvais', kind: 'inconnu' },
            42,
        ],
    }),
);
const read = store.readRules();
assert.strictEqual(read.length, 1);
assert.strictEqual(read[0].id, 'ok-1');
// …mais signalée (verrou des événements de cette règle côté sync)
assert.deepStrictEqual(store.readRuleSet().invalid, ['ko-1']);

// Une écriture conserve les entrées invalides telles quelles
const added = store.createRule(
    { title: 'Nouvelle', kind: 'first-workday-month' },
    today,
);
const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).rules;
assert.deepStrictEqual(
    onDisk.find((x: any) => x && x.id === 'ko-1'),
    { id: 'ko-1', title: 'Mauvais', kind: 'inconnu' },
);
assert.ok(onDisk.includes(42));
assert.strictEqual(onDisk.length, 4);
store.updateRule('ok-1', { title: 'Bon 2', kind: 'last-workday-month' }, today);
assert.strictEqual(store.deleteRule(added.id), true);
const after = JSON.parse(fs.readFileSync(file, 'utf8')).rules;
assert.ok(after.some((x: any) => x && x.id === 'ko-1' && x.kind === 'inconnu'));
assert.ok(after.includes(42));
// Un id d'entrée invalide n'est pas réutilisable
assert.throws(() =>
    store.createRule(
        { id: 'ko-1', title: 'X', kind: 'first-workday-month' },
        today,
    ),
);

// Fichier illisible → erreur (jamais « aucune règle »), et aucune écriture
fs.writeFileSync(file, '{pas du json');
assert.throws(() => store.readRules(), store.RulesFileError);
assert.throws(() => store.readRuleSet(), store.RulesFileError);
assert.throws(
    () => store.createRule({ title: 'X', kind: 'first-workday-month' }, today),
    store.RulesFileError,
);
assert.throws(() => store.deleteRule('ok-1'), store.RulesFileError);
assert.strictEqual(fs.readFileSync(file, 'utf8'), '{pas du json');

// Forme inattendue → erreur aussi
for (const bad of ['{"regles": []}', '42', 'null', '{"rules": {}}']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => store.readRules(), store.RulesFileError, bad);
}
// Tableau nu : forme historique acceptée
fs.writeFileSync(file, '[]');
assert.deepStrictEqual(store.readRules(), []);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('calendarRules/store.test OK');
