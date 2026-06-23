import assert from 'assert';
import * as fs from 'fs';
import { Dedup } from './dedup';

function run(): void {
    const cooldown = 30 * 60_000; // 30 min

    // --- comportement de cooldown (inchangé) ---
    {
        const d = new Dedup();
        assert.strictEqual(d.isDuplicate('door', 0, cooldown), false);
        d.record('door', 0);
        assert.strictEqual(d.isDuplicate('door', 10 * 60_000, cooldown), true);
        assert.strictEqual(d.isDuplicate('door', 31 * 60_000, cooldown), false);
        assert.strictEqual(d.isDuplicate('other', 0, cooldown), false);
    }

    // --- mémorisation du message ---
    {
        const d = new Dedup();
        assert.strictEqual(d.lastMessage('temp'), undefined);
        d.record('temp', 1000, 'Il fait 28 degrés');
        assert.strictEqual(d.lastMessage('temp'), 'Il fait 28 degrés');
    }

    // --- record sans message : ré-arme at, conserve le message ---
    {
        const d = new Dedup();
        d.record('temp', 1000, 'Il fait 28 degrés');
        d.record('temp', 5000); // ré-arme, pas de nouveau message
        assert.strictEqual(d.lastMessage('temp'), 'Il fait 28 degrés');
        // at a bien été bumpé : à 5000 + 10 min, c'est un doublon
        assert.strictEqual(
            d.isDuplicate('temp', 5000 + 10 * 60_000, cooldown),
            true,
        );
        // alors qu'avec l'ancien at (1000) ça ne l'aurait plus été
        assert.strictEqual(
            d.isDuplicate('temp', 1000 + 31 * 60_000, cooldown),
            false,
        );
    }

    // --- record sans message sur sujet neuf : message = '' ---
    {
        const d = new Dedup();
        d.record('fresh', 1000);
        assert.strictEqual(d.lastMessage('fresh'), '');
    }

    // --- persistance : nouveau format relu (at + message) ---
    {
        const file = 'data/proactive-dedup.test.json';
        fs.rmSync(file, { force: true });
        try {
            const a = new Dedup(file);
            a.record('door', 1000, 'porte ouverte');
            const b = new Dedup(file);
            assert.strictEqual(b.lastMessage('door'), 'porte ouverte');
            assert.strictEqual(
                b.isDuplicate('door', 1000 + 10 * 60_000, cooldown),
                true,
            );
            assert.strictEqual(
                b.isDuplicate('door', 1000 + 31 * 60_000, cooldown),
                false,
            );
        } finally {
            fs.rmSync(file, { force: true });
        }
    }

    // --- rétro-compat : ancien fichier plat { subject: number } ---
    {
        const file = 'data/proactive-dedup.legacy.test.json';
        fs.rmSync(file, { force: true });
        try {
            fs.writeFileSync(file, JSON.stringify({ door: 1000 }));
            const d = new Dedup(file);
            assert.strictEqual(
                d.isDuplicate('door', 1000 + 10 * 60_000, cooldown),
                true,
            );
            assert.strictEqual(d.lastMessage('door'), '');
        } finally {
            fs.rmSync(file, { force: true });
        }
    }

    console.log('All dedup tests passed');
}

run();
