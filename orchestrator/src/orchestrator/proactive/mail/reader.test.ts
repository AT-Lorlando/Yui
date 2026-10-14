import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DEFAULT_READER_PROMPT,
    buildReaderSystem,
    buildReaderUser,
    loadReaderPrompt,
    parseReaderReply,
} from './reader';
import type { MailOrder } from './orders';

function order(id: string, text: string, state: MailOrder['state']): MailOrder {
    return {
        id,
        text,
        createdAt: 0,
        expiresAt: Date.UTC(2026, 9, 28, 12),
        source: 'user',
        state,
    };
}

export function run(): void {
    // system : ordres actifs seulement
    const sys = buildReaderSystem('GENERAL', [
        order('o-1', 'Attends la réponse du syndic', 'active'),
        order('o-2', 'Ancien ordre', 'fulfilled'),
    ]);
    assert.ok(sys.startsWith('GENERAL'));
    assert.ok(sys.includes('Ordres en cours'));
    assert.ok(sys.includes('[o-1]'));
    assert.ok(!sys.includes('o-2'));
    assert.ok(sys.includes('UNIQUEMENT'));
    assert.ok(!buildReaderSystem('G', []).includes('Ordres en cours'));

    // user
    const u = buildReaderUser([
        { id: 'a', from: 'x@y.fr', subject: 'Salut', body: 'Corps A' },
        {
            id: 'b',
            from: 'z@y.fr',
            subject: 'Yo',
            date: '2026-10-01',
            body: 'Corps B',
            box: 'Banque',
        },
    ]);
    assert.ok(u.includes('1. De: x@y.fr | Objet: Salut'));
    assert.ok(u.includes('2. De: z@y.fr'));
    assert.ok(u.includes('Date: 2026-10-01'));
    assert.ok(u.includes('Boîte: Banque'));
    assert.ok(u.includes('Corps: Corps B'));

    const ids = new Set(['o-1']);

    // réponse propre
    let r = parseReaderReply(
        '[{"i":1,"notify":true,"urgency":"now","reason":"Échéance","orderId":"o-1","fulfilled":true,"facts":["12 €"]},{"i":2,"notify":false}]',
        2,
        ids,
    );
    assert.deepStrictEqual(r[0], {
        notify: true,
        urgency: 'now',
        reason: 'Échéance',
        orderId: 'o-1',
        fulfilled: true,
        facts: ['12 €'],
    });
    assert.deepStrictEqual(r[1], {
        notify: false,
        urgency: 'none',
        reason: '',
        facts: [],
    });

    // texte autour
    r = parseReaderReply(
        'Voici:\n```json\n[{"i":1,"notify":true,"urgency":"soon","reason":"r"}]\n```\nFin',
        1,
        ids,
    );
    assert.strictEqual(r[0]?.notify, true);
    assert.strictEqual(r[0]?.urgency, 'soon');

    // orderId inconnu : jeté avec fulfilled ; i hors bornes ignoré
    r = parseReaderReply(
        '[{"i":1,"notify":true,"orderId":"o-9","fulfilled":true},{"i":5,"notify":true},{"i":0}]',
        1,
        ids,
    );
    assert.ok(r[0]);
    assert.ok(!('orderId' in r[0]!));
    assert.ok(!('fulfilled' in r[0]!));
    assert.strictEqual(r.length, 1);

    // fulfilled sans orderId connu : omis ; orderId connu sans fulfilled : omis
    r = parseReaderReply('[{"i":1,"orderId":"o-1"}]', 1, ids);
    assert.strictEqual(r[0]?.orderId, 'o-1');
    assert.ok(!('fulfilled' in r[0]!));

    // notify "yes" -> false, urgency hors enum -> none
    r = parseReaderReply('[{"i":1,"notify":"yes","urgency":"asap"}]', 1, ids);
    assert.strictEqual(r[0]?.notify, false);
    assert.strictEqual(r[0]?.urgency, 'none');

    // reason tronquée, facts bornés
    r = parseReaderReply(
        JSON.stringify([
            {
                i: 1,
                reason: 'r'.repeat(300),
                facts: [
                    'a'.repeat(200),
                    '',
                    '   ',
                    42,
                    'b',
                    'c',
                    'd',
                    'e',
                    'f',
                ],
            },
        ]),
        1,
        ids,
    );
    assert.strictEqual(r[0]?.reason.length, 160);
    assert.strictEqual(r[0]?.facts.length, 5);
    assert.strictEqual(r[0]?.facts[0].length, 120);
    assert.deepStrictEqual(r[0]?.facts.slice(1), ['b', 'c', 'd', 'e']);

    // illisible
    assert.deepStrictEqual(parseReaderReply('pas du json', 3, ids), [
        null,
        null,
        null,
    ]);
    assert.deepStrictEqual(parseReaderReply('[oops', 2, ids), [null, null]);
    assert.deepStrictEqual(parseReaderReply('[1,2]', 2, ids), [null, null]);

    // loadReaderPrompt
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-'));
    try {
        assert.strictEqual(loadReaderPrompt(dir), DEFAULT_READER_PROMPT);
        fs.writeFileSync(path.join(dir, 'mail-reader.md'), '  \n ');
        assert.strictEqual(loadReaderPrompt(dir), DEFAULT_READER_PROMPT);
        fs.writeFileSync(path.join(dir, 'mail-reader.md'), '  Mon prompt\n');
        assert.strictEqual(loadReaderPrompt(dir), 'Mon prompt');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('reader: all tests passed');
}

if (require.main === module) run();
