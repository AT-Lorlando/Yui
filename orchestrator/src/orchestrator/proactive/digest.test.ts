import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DigestBuffer, isDigestDue } from './digest';
import type { CandidateEvent } from './types';

function ev(subject: string): CandidateEvent {
    return {
        watcherId: 'w',
        subject,
        importance: 'info',
        facts: `fait ${subject}`,
    };
}

function run(): void {
    const file = path.resolve(process.cwd(), 'data/proactive-digest.test.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    try {
        const buf = new DigestBuffer(file);
        buf.add(ev('a'));
        buf.add(ev('b'));
        buf.add(ev('a')); // doublon de sujet → ignoré
        assert.strictEqual(buf.size(), 2);

        const taken = buf.takeAll(123);
        assert.strictEqual(taken.length, 2);
        assert.strictEqual(buf.size(), 0);
        assert.strictEqual(buf.lastFlush(), 123);

        // persistance : un nouveau buffer relit le fichier vidé
        const buf2 = new DigestBuffer(file);
        assert.strictEqual(buf2.size(), 0);

        // échéance digest à 07:00
        const due = new Date('2026-05-29T07:05:00');
        assert.strictEqual(isDigestDue(due, '07:00', 0), true);
        const beforeDue = new Date('2026-05-29T06:00:00');
        assert.strictEqual(isDigestDue(beforeDue, '07:00', 0), false);
        // déjà flushé aujourd'hui après l'heure → pas de re-flush
        const alreadyFlushed = new Date('2026-05-29T07:05:00').getTime();
        assert.strictEqual(isDigestDue(due, '07:00', alreadyFlushed), false);

        console.log('All digest tests passed');
    } finally {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
}

run();
