import assert from 'assert';
import { parseNotifyRequest, NOTIFY_TEXT_MAX } from './notifyRequest';

// Minimal : texte seul → titre Yui, pas de parole.
assert.deepStrictEqual(parseNotifyRequest({ text: ' Disque plein sur nas ' }), {
    text: 'Disque plein sur nas',
    title: 'Yui',
    speak: false,
});

// Source → titre par défaut + journal ; speak accepté en booléen ou 'true'.
const k = parseNotifyRequest({
    message: 'PM2 down',
    source: 'Koya',
    speak: 'true',
});
assert.strictEqual(k.title, 'Koya');
assert.strictEqual(k.source, 'Koya');
assert.strictEqual(k.speak, true);
assert.strictEqual(
    parseNotifyRequest({ body: 'x', title: 'Alerte' }).title,
    'Alerte',
);

// Refus : vide, trop long, corps non objet.
assert.throws(() => parseNotifyRequest({}), /text requis/);
assert.throws(() => parseNotifyRequest(null), /text requis/);
assert.throws(
    () => parseNotifyRequest({ text: 'a'.repeat(NOTIFY_TEXT_MAX + 1) }),
    /trop long/,
);

console.log('All notifyRequest tests passed');
