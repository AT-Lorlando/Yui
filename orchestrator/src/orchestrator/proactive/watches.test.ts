// Attentes : normalisation, correspondance (tous les mots-clés requis,
// source filtrante) et store (bornes, expiration, purge 24 h, persistance).
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    WatchStore,
    matchWatch,
    normalizeText,
    WATCHES_MAX,
    WATCH_DAYS_DEFAULT,
    WATCH_KEEP_DONE_MS,
} from './watches';
import type { Watch } from './watches';
import type { Event } from './events';

const NOW = new Date('2026-10-15T14:00:00').getTime();
const DAY = 86_400_000;
const tmpFile = () =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-w-')), 'watches.json');

const ev = (over: Partial<Event> = {}): Event => ({
    source: 'mail',
    key: 'm-1',
    kind: 'info',
    importance: 'utile',
    subject: 'Réponse de Michel',
    facts: ['À propos du devis'],
    at: NOW,
    ...over,
});

const watch = (over: Partial<Watch> = {}): Watch => ({
    id: 'w-000001',
    text: 'la réponse de Michel',
    keywords: ['michel'],
    createdAt: NOW,
    expiresAt: NOW + DAY,
    state: 'active',
    origin: 'app',
    ...over,
});

function throws(fn: () => unknown, re: RegExp): void {
    assert.throws(fn, (err: any) => re.test(err.message));
}

function run(): void {
    // ── normalizeText ─────────────────────────────────────────────────
    assert.strictEqual(normalizeText('Réponse de Michel'), 'reponse de michel');
    assert.strictEqual(normalizeText('  Ça   VA\tbien '), 'ca va bien');

    // ── matchWatch ────────────────────────────────────────────────────
    assert.ok(matchWatch(watch({ keywords: ['Michel'] }), ev()), 'casse');
    assert.ok(
        matchWatch(watch({ keywords: ['réponse', 'MICHEL'] }), ev()),
        'tous les mots-clés',
    );
    assert.ok(
        matchWatch(watch({ keywords: ['reponse'] }), ev()),
        'accents ignorés côté événement',
    );
    assert.ok(
        matchWatch(watch({ keywords: ['dévis'] }), ev({ facts: ['devis'] })),
        'accents ignorés côté mot-clé',
    );
    assert.ok(
        matchWatch(watch({ keywords: ['devis', 'michel'] }), ev()),
        'mot-clé dans un fait',
    );
    assert.ok(
        matchWatch(watch({ keywords: ['m-1'] }), ev()),
        'mot-clé dans la clé',
    );
    assert.ok(
        !matchWatch(watch({ keywords: ['michel', 'facture'] }), ev()),
        'un seul mot-clé sur deux → pas de match',
    );
    assert.ok(
        matchWatch(watch({ source: 'mail', keywords: ['michel'] }), ev()),
        'source égale',
    );
    assert.ok(
        !matchWatch(
            watch({ source: 'deliveries', keywords: ['michel'] }),
            ev(),
        ),
        'source filtrante',
    );
    // Événements externes : source brute (`koya`), brique `external:koya`.
    assert.ok(
        matchWatch(
            watch({ source: 'external:koya', keywords: ['michel'] }),
            ev({ source: 'koya' }),
        ),
        'external:<app> couvre la source brute',
    );
    assert.ok(
        matchWatch(
            watch({ source: 'koya', keywords: ['michel'] }),
            ev({ source: 'koya' }),
        ),
        'source brute égale',
    );
    assert.ok(
        !matchWatch(
            watch({ source: 'mail', keywords: ['michel'] }),
            ev({ source: 'koya' }),
        ),
        'mail ≠ koya',
    );

    // ── Store : bornes ────────────────────────────────────────────────
    const s = new WatchStore(tmpFile());
    const base = { text: 'La réponse de Michel', keywords: ['michel'] };
    throws(() => s.add({ ...base, text: 'abc', origin: 'app' }, NOW), /texte/);
    throws(
        () => s.add({ ...base, text: 'x'.repeat(301), origin: 'app' }, NOW),
        /texte/,
    );
    throws(
        () => s.add({ ...base, keywords: [], origin: 'app' }, NOW),
        /mots-clés/,
    );
    throws(
        () =>
            s.add(
                {
                    ...base,
                    keywords: ['a', 'b', 'c', 'd', 'e', 'f'],
                    origin: 'app',
                },
                NOW,
            ),
        /mots-clés/,
    );
    throws(
        () => s.add({ ...base, keywords: ['ok', '  '], origin: 'app' }, NOW),
        /mot-clé/,
    );
    throws(
        () =>
            s.add({ ...base, keywords: ['x'.repeat(41)], origin: 'app' }, NOW),
        /mot-clé/,
    );
    throws(() => s.add({ ...base, days: 0, origin: 'app' }, NOW), /durée/);
    throws(() => s.add({ ...base, days: 61, origin: 'app' }, NOW), /durée/);
    assert.strictEqual(s.all().length, 0, 'rien ajouté sur erreur');

    const w = s.add(
        { ...base, source: 'mail', origin: 'voice', mailOrderId: 'o-abc' },
        NOW,
    );
    assert.match(w.id, /^w-[0-9a-f]{6}$/);
    assert.strictEqual(w.state, 'active');
    assert.strictEqual(w.expiresAt, NOW + WATCH_DAYS_DEFAULT * DAY);
    assert.strictEqual(w.origin, 'voice');
    assert.strictEqual(s.byMailOrder('o-abc')?.id, w.id);
    assert.strictEqual(s.byMailOrder('o-zzz'), undefined);
    assert.strictEqual(s.find(w.id)?.text, 'La réponse de Michel');

    // Plafond d'actives.
    const cap = new WatchStore(tmpFile());
    for (let i = 0; i < WATCHES_MAX; i++)
        cap.add({ ...base, origin: 'app' }, NOW);
    throws(() => cap.add({ ...base, origin: 'app' }, NOW), /Trop/);
    // Une expirée libère une place.
    cap.all()[0]!.expiresAt = NOW - 1;
    cap.add({ ...base, origin: 'app' }, NOW);

    // ── fulfill / expire / purge ──────────────────────────────────────
    const s2 = new WatchStore(tmpFile());
    const a = s2.add({ ...base, days: 1, origin: 'app' }, NOW);
    const b = s2.add({ ...base, days: 3, origin: 'app' }, NOW);
    const f = s2.fulfill(b.id, { key: 'm-9', subject: 'Re: devis' }, NOW + 10);
    assert.strictEqual(f?.state, 'fulfilled');
    assert.strictEqual(f?.matchedKey, 'm-9');
    assert.strictEqual(f?.matchedSubject, 'Re: devis');
    assert.strictEqual(f?.fulfilledAt, NOW + 10);
    assert.strictEqual(
        s2.fulfill(b.id, { key: 'm-10', subject: 'autre' }, NOW + 20),
        undefined,
        'déjà satisfaite : rien ne change',
    );
    assert.strictEqual(s2.find(b.id)?.matchedKey, 'm-9');
    assert.strictEqual(
        s2.fulfill('w-nope', { key: 'k', subject: 's' }, NOW),
        undefined,
    );
    assert.deepStrictEqual(
        s2.active(NOW).map((x) => x.id),
        [a.id],
    );

    s2.expire(NOW + DAY);
    assert.strictEqual(s2.find(a.id)?.state, 'expired', 'échue → expired');
    assert.strictEqual(s2.active(NOW + DAY).length, 0);
    s2.expire(NOW + 10 + WATCH_KEEP_DONE_MS);
    assert.strictEqual(s2.all().length, 2, 'satisfaite gardée 24 h');
    s2.expire(NOW + DAY + WATCH_KEEP_DONE_MS);
    assert.deepStrictEqual(
        s2.all().map((x) => x.id),
        [a.id],
        'satisfaite purgée, expirée gardée 24 h après échéance',
    );
    s2.expire(NOW + DAY + WATCH_KEEP_DONE_MS + 1);
    assert.deepStrictEqual(
        s2.all().map((x) => x.id),
        [],
        'purgées après 24 h',
    );

    // ── remove + persistance ──────────────────────────────────────────
    const file = tmpFile();
    const s3 = new WatchStore(file);
    const c = s3.add({ ...base, origin: 'app' }, NOW);
    const d = s3.add({ ...base, origin: 'app' }, NOW);
    assert.ok(s3.remove(c.id));
    assert.ok(!s3.remove(c.id));
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual(raw.version, 1);
    const reread = new WatchStore(file);
    assert.deepStrictEqual(
        reread.all().map((x) => x.id),
        [d.id],
    );
    assert.deepStrictEqual(reread.find(d.id)?.keywords, ['michel']);

    // Fichier absent ou corrompu → vide.
    assert.strictEqual(new WatchStore(tmpFile()).all().length, 0);
    const bad = tmpFile();
    fs.writeFileSync(bad, '{oops');
    assert.strictEqual(new WatchStore(bad).all().length, 0);

    console.log('All watches tests passed');
}

try {
    run();
} catch (e: any) {
    console.error(e.message ?? e);
    process.exit(1);
}
