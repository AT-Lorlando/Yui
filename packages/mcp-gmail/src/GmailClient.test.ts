import assert from 'assert';
import { GmailClient } from './GmailClient';
const fakeApi = {
    users: {
        messages: {
            list: async (p: any) => {
                calls.push(['list', p]);
                return { data: { messages: [{ id: 'm1' }, { id: 'm2' }] } };
            },
            get: async (p: any) => {
                calls.push(['get', p]);
                if (p.id === 'm2') {
                    // En-têtes tels qu'un expéditeur réel les écrit — pas la
                    // casse canonique attendue par un .includes() strict.
                    return {
                        data: {
                            id: p.id,
                            threadId: 't2',
                            internalDate: '1759050000000',
                            snippet: 'Aperçu',
                            labelIds: ['INBOX'],
                            payload: {
                                headers: [
                                    { name: 'From', value: 'B <b@c.d>' },
                                    { name: 'Subject', value: 'S2' },
                                    {
                                        name: 'list-unsubscribe',
                                        value: '<y>',
                                    },
                                    { name: 'PRECEDENCE', value: 'bulk' },
                                ],
                            },
                        },
                    };
                }
                return {
                    data: {
                        id: p.id,
                        threadId: 't1',
                        internalDate: '1759050000000',
                        snippet: 'Aperçu',
                        labelIds: ['INBOX', 'UNREAD'],
                        payload: {
                            headers: [
                                { name: 'From', value: 'A <a@b.c>' },
                                { name: 'Subject', value: 'S' },
                                { name: 'List-Unsubscribe', value: '<x>' },
                            ],
                        },
                    },
                };
            },
        },
    },
} as any;
const calls: any[] = [];
async function run() {
    const c = new GmailClient({} as any, fakeApi);
    const out = await c.listMessagesMeta('in:inbox', 7);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0]!.from, 'A <a@b.c>');
    assert.strictEqual(out[0]!.headers['List-Unsubscribe'], '<x>');
    assert.strictEqual(out[0]!.date, new Date(1759050000000).toISOString());
    assert.deepStrictEqual(out[0]!.labelIds, ['INBOX', 'UNREAD']);
    // En-têtes casés comme l'expéditeur les a écrits : gardés quand même
    // (comparaison insensible à la casse, nom d'en-tête reçu conservé).
    assert.strictEqual(out[1]!.headers['list-unsubscribe'], '<y>');
    assert.strictEqual(out[1]!.headers['PRECEDENCE'], 'bulk');
    const list = calls.find((c) => c[0] === 'list')![1];
    assert.strictEqual(list.q, 'in:inbox');
    assert.strictEqual(list.maxResults, 7);
    const get = calls.find((c) => c[0] === 'get')![1];
    assert.strictEqual(get.format, 'metadata');
    assert.ok(
        get.metadataHeaders.includes('Precedence') &&
            get.metadataHeaders.includes('Auto-Submitted'),
    );
    // plafond 100
    calls.length = 0;
    await c.listMessagesMeta('x', 500);
    assert.strictEqual(calls.find((c) => c[0] === 'list')![1].maxResults, 100);
    console.log('gmail meta ok');
}
run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
