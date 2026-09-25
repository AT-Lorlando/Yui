import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// Le concierge persiste son état via dataPath() : isoler YUI_DATA_DIR AVANT de
// résoudre ./mail (même contrainte que connectors.test.ts).
process.env.YUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-mailc-'));
const { mailConnector } = require('./mail') as typeof import('./mail');
const { MailConcierge } =
    require('../mail/concierge') as typeof import('../mail/concierge');
const { ConnectorState } =
    require('../connectorState') as typeof import('../connectorState');
import type { ConnectorContext } from '../connector';

const NOW = new Date('2026-09-25T10:00:00').getTime();
// Format réel de search_emails, tel que parseSearchOutput() le découpe
// (`ID:`, `De:`, `Objet:`, `Apercu:` — sans accent).
const SEARCH =
    'ID: m1\nDe: LinkedIn <jobs@linkedin.com>\nObjet: Nouvelle proposition DevOps\nDate: 2026-09-25\nApercu: Un recruteur…\n';

async function run(): Promise<void> {
    let scans = 0;
    const concierge = new MailConcierge(
        {
            deviceHandler: async (t) =>
                t === 'search_emails'
                    ? SEARCH
                    : t === 'get_email'
                    ? 'corps'
                    : null,
            // parseClassifyReply() indexe les mails par `i` (1-based).
            complete: async () => '[{"i":1,"category":"action"}]',
            getRules: () => [],
            addRule: () => {},
            getAutoCategories: () => [],
            readBodies: false,
            now: () => NOW,
        },
        path.join(process.env.YUI_DATA_DIR!, 'triage.json'),
    );
    const origScan = concierge.scan.bind(concierge);
    concierge.scan = async (...a) => {
        scans++;
        return origScan(...a);
    };

    const state = new ConnectorState();
    const ctx = (settings: Record<string, unknown>): ConnectorContext => ({
        callTool: async (t) => (t === 'search_emails' ? SEARCH : null),
        settings,
        state,
        presence: () => 'home',
        now: () => NOW,
        log: { info: () => {}, warn: () => {} },
    });
    const c = mailConnector({ concierge });

    // Tri inactif : seulement les mails importants (evaluateMail).
    const off = await c.events!(ctx({ triage: false, query: 'is:important' }));
    assert.strictEqual(scans, 0);
    assert.strictEqual(off.length, 1);
    assert.strictEqual(off[0]!.key, 'important-mail');

    // Tri actif : scan + un événement par action, jamais répété.
    const on = await c.events!(ctx({ triage: true }));
    assert.strictEqual(scans, 1);
    assert.ok(
        on.some((e) => e.key === 'mail-action-m1' && e.kind === 'request'),
    );
    const again = await c.events!(ctx({ triage: true }));
    assert.ok(!again.some((e) => e.key === 'mail-action-m1'), 'déjà signalé');

    const snap = await c.snapshot!(ctx({ triage: true }));
    assert.ok(snap.some((f) => f.label === 'Courrier'));
    assert.ok(
        snap.some((f) => f.label === 'À traiter' && f.value.includes('DevOps')),
    );

    console.log('All mail connector tests passed');
}

run().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
});
