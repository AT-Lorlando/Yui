import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateMailRulesAtBoot, RULES_BACKUP_NAME } from './bootMigration';
import { MailCourier } from './courier';
import { MailJournal } from './journal';
import { OrderStore } from './orders';
import { SenderStore } from './senders';

const NOW = 1_800_000_000_000;

function run(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-bootmig-'));
    const rulesFile = path.join(dir, 'mail-rules.json');
    const reportFile = path.join(dir, 'mail-migration.json');
    const base = { origin: 'user', confirmed: true, hits: 0, createdAt: 1 };
    fs.writeFileSync(
        rulesFile,
        JSON.stringify({
            version: 1,
            rules: [
                {
                    ...base,
                    id: 'r1',
                    when: { from: 'promo.io' },
                    then: { category: 'promo' },
                },
                {
                    ...base,
                    id: 'r2',
                    when: { from: 'news.shop.com' },
                    then: { category: 'newsletter' },
                    origin: 'signal',
                    confirmed: false,
                },
            ],
        }),
    );
    const senders = new SenderStore(path.join(dir, 'mail-senders.json'));
    const courier = new MailCourier(
        {
            deviceHandler: async () => '[]',
            complete: async () => '[]',
            senders,
            orders: new OrderStore(path.join(dir, 'orders.json')),
            journal: new MailJournal(path.join(dir, 'journal.json')),
            readerPrompt: () => '',
            onNotify: () => {},
            now: () => NOW,
        },
        path.join(dir, 'mail-courier.json'),
    );

    const report = migrateMailRulesAtBoot(senders, NOW, {
        rulesFile,
        reportFile,
        seedUnknown: (entries) => courier.seedUnknown(entries),
    });
    assert.ok(report);
    assert.deepStrictEqual(report!.unknown, [
        { match: 'news.shop.com', proposed: 'spam' },
    ]);
    assert.deepStrictEqual(
        senders.spam().map((s) => s.match),
        ['promo.io'],
    );
    // spec §5 : l'inconnu proposé osef est dans la file « à trier »
    const u = courier.unknown();
    assert.strictEqual(u.length, 1);
    assert.strictEqual(u[0].address, 'news.shop.com');
    assert.strictEqual(u[0].signal, 'quarantaine');
    assert.strictEqual(u[0].count, 0);
    assert.strictEqual(u[0].lastAt, NOW);
    assert.ok(fs.existsSync(path.join(dir, RULES_BACKUP_NAME)));
    assert.ok(fs.existsSync(reportFile));

    // deuxième démarrage : listes déjà là → rien
    assert.strictEqual(
        migrateMailRulesAtBoot(senders, NOW, {
            rulesFile,
            reportFile,
            seedUnknown: () => assert.fail('pas de seconde migration'),
        }),
        null,
    );
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('bootMigration: all tests passed');
}

run();
