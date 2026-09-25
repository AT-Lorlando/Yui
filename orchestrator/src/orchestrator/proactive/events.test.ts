import assert from 'assert';
import {
    parseEvent,
    parseEvents,
    isExpired,
    fromCandidate,
    eventKey,
    factsFingerprint,
    SUBJECT_MAX,
    BATCH_MAX,
} from './events';

const NOW = new Date('2026-09-25T10:00:00').getTime();

async function run(): Promise<void> {
    // Minimal valide : défauts (facts [], at = now).
    const e = parseEvent(
        {
            source: 'koya',
            key: 'disk-nas',
            kind: 'alert',
            importance: 'utile',
            subject: 'Disque nas à 94 %',
        },
        { now: NOW },
    );
    assert.deepStrictEqual(e, {
        source: 'koya',
        key: 'disk-nas',
        kind: 'alert',
        importance: 'utile',
        subject: 'Disque nas à 94 %',
        facts: [],
        at: NOW,
    });
    assert.strictEqual(eventKey(e), 'koya:disk-nas');

    // Champs optionnels conservés et bornés ; facts en lignes trimées, vides ôtées.
    const full = parseEvent(
        {
            source: ' Koya ',
            key: 'pm2',
            kind: 'alert',
            importance: 'urgent',
            subject: 'PM2 down',
            facts: [' yui-voice ', '', 'exit 1'],
            at: NOW - 1000,
            ttlMs: 60_000,
            link: 'https://koya.home.arpa/hosts/1',
            action: { id: 'restart', tag: 'pm2' },
        },
        { now: NOW },
    );
    assert.strictEqual(full.source, 'Koya');
    assert.deepStrictEqual(full.facts, ['yui-voice', 'exit 1']);
    assert.strictEqual(full.ttlMs, 60_000);
    assert.strictEqual(full.link, 'https://koya.home.arpa/hosts/1');
    assert.deepStrictEqual(full.action, { id: 'restart', tag: 'pm2' });

    // Refus.
    const bad = (raw: unknown, re: RegExp) =>
        assert.throws(() => parseEvent(raw, { now: NOW }), re);
    bad(null, /objet/);
    bad({ key: 'k', kind: 'info', importance: 'info', subject: 's' }, /source/);
    bad({ source: 's', kind: 'info', importance: 'info', subject: 's' }, /key/);
    bad(
        {
            source: 's',
            key: 'k',
            kind: 'bof',
            importance: 'info',
            subject: 's',
        },
        /kind/,
    );
    bad(
        {
            source: 's',
            key: 'k',
            kind: 'info',
            importance: 'meh',
            subject: 's',
        },
        /importance/,
    );
    bad(
        {
            source: 's',
            key: 'k',
            kind: 'info',
            importance: 'info',
            subject: '',
        },
        /subject/,
    );
    bad(
        {
            source: 's',
            key: 'k',
            kind: 'info',
            importance: 'info',
            subject: 'x'.repeat(SUBJECT_MAX + 1),
        },
        /subject/,
    );
    bad(
        {
            source: 's',
            key: 'k',
            kind: 'info',
            importance: 'info',
            subject: 's',
            facts: Array(11).fill('f'),
        },
        /facts/,
    );
    bad(
        {
            source: 's',
            key: 'k',
            kind: 'info',
            importance: 'info',
            subject: 's',
            ttlMs: -1,
        },
        /ttlMs/,
    );
    bad(
        {
            source: 's',
            key: 'k',
            kind: 'info',
            importance: 'info',
            subject: 's',
            link: 'ftp://x',
        },
        /link/,
    );

    // Péremption.
    assert.strictEqual(isExpired(full, NOW), false);
    assert.strictEqual(isExpired(full, NOW + 60_000), true);
    assert.strictEqual(
        isExpired(e, NOW + 10 * 365 * 24 * 3600_000),
        false,
        'sans ttl = jamais périmé',
    );

    // Tableau : tout ou rien, borné.
    const batch = parseEvents([e, { source: 'x' }], { now: NOW });
    assert.strictEqual(batch.events.length, 0, 'un invalide → rien accepté');
    assert.deepStrictEqual(
        batch.errors.map((x) => x.index),
        [1],
    );
    assert.ok(/key/.test(batch.errors[0]!.message));
    assert.strictEqual(
        parseEvents(e, { now: NOW }).events.length,
        1,
        'objet seul accepté',
    );
    assert.strictEqual(
        parseEvents(Array(BATCH_MAX + 1).fill(e), { now: NOW }).errors[0]!
            .index,
        -1,
    );

    // Empreinte des facts : ordre et casse comptent, espaces non.
    assert.strictEqual(
        factsFingerprint({ ...e, facts: ['a ', 'b'] }),
        factsFingerprint({ ...e, facts: ['a', 'b '] }),
    );
    assert.notStrictEqual(
        factsFingerprint({ ...e, facts: ['a'] }),
        factsFingerprint({ ...e, facts: ['b'] }),
    );

    // Adaptateur legacy : CandidateEvent → Event.
    const c = fromCandidate(
        {
            watcherId: 'weather',
            subject: 'rain-now',
            importance: 'info',
            facts: 'Il pleut.',
            cooldownMs: 3600_000,
        },
        NOW,
    );
    assert.strictEqual(c.source, 'weather');
    assert.strictEqual(c.key, 'rain-now');
    assert.strictEqual(c.kind, 'info');
    assert.deepStrictEqual(c.facts, ['Il pleut.']);
    assert.strictEqual(c.subject, 'Il pleut.');
    assert.strictEqual(c.cooldownMs, 3600_000);
    assert.strictEqual(
        fromCandidate(
            { watcherId: 'w', subject: 's', importance: 'urgent', facts: 'x' },
            NOW,
        ).kind,
        'alert',
    );
    assert.strictEqual(
        fromCandidate(
            {
                watcherId: 'w',
                subject: 's',
                importance: 'utile',
                facts: 'x',
                proposedAction: { id: 'a', tag: 't' },
            },
            NOW,
        ).kind,
        'request',
    );

    console.log('All events tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
