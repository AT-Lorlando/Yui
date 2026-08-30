import assert from 'assert';
import { confirmDeparture } from './departureGuard';
import { PresenceManager } from './presence';

const instantSleep = async () => {};

// ── confirmDeparture (pur) ───────────────────────────────────────────────────
async function testGuard(): Promise<void> {
    // Le cas du 17/08 : EXIT fantôme à 01h18, téléphone sur le wifi → veto.
    {
        const verdict = await confirmDeparture({
            delayMs: 60000,
            checks: 3,
            intervalMs: 20000,
            isPhoneHome: async () => true,
            sleep: instantSleep,
        });
        assert.strictEqual(verdict, 'vetoed');
    }
    // Vrai départ : jamais vu sur le réseau → confirmé.
    {
        let calls = 0;
        const verdict = await confirmDeparture({
            delayMs: 60000,
            checks: 3,
            intervalMs: 20000,
            isPhoneHome: async () => (calls++, false),
            sleep: instantSleep,
        });
        assert.strictEqual(verdict, 'confirmed');
        assert.strictEqual(calls, 3, 'toutes les vérifications sont faites');
    }
    // Téléphone vu à la 2e vérification (ARP tardif) → veto quand même.
    {
        let calls = 0;
        const verdict = await confirmDeparture({
            delayMs: 0,
            checks: 3,
            intervalMs: 0,
            isPhoneHome: async () => ++calls === 2,
            sleep: instantSleep,
        });
        assert.strictEqual(verdict, 'vetoed');
    }
    // Routeur injoignable (null) sur toute la fenêtre → on confirme (on ne
    // peut pas bloquer les départs à vie sur un routeur muet).
    {
        const verdict = await confirmDeparture({
            delayMs: 0,
            checks: 2,
            intervalMs: 0,
            isPhoneHome: async () => null,
            sleep: instantSleep,
        });
        assert.strictEqual(verdict, 'confirmed');
    }
    // Annulation externe (ENTER pendant la fenêtre).
    {
        let cancelled = false;
        const verdict = await confirmDeparture({
            delayMs: 0,
            checks: 3,
            intervalMs: 0,
            isPhoneHome: async () => {
                cancelled = true;
                return false;
            },
            isCancelled: () => cancelled,
            sleep: instantSleep,
        });
        assert.strictEqual(verdict, 'cancelled');
    }
    // La vérification qui throw ne compte ni comme présent ni comme absent.
    {
        const verdict = await confirmDeparture({
            delayMs: 0,
            checks: 1,
            intervalMs: 0,
            isPhoneHome: async () => {
                throw new Error('arp broke');
            },
            sleep: instantSleep,
        });
        assert.strictEqual(verdict, 'confirmed');
    }
}

// ── Câblage dans PresenceManager ─────────────────────────────────────────────
class TestManager extends PresenceManager {
    public networkPresent: boolean | null = true;
    public checks = 0;
    protected override checkNetwork(): Promise<{ present: boolean | null }> {
        this.checks++;
        return Promise.resolve({ present: this.networkPresent });
    }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function testManagerWiring(): Promise<void> {
    // NB : la config réelle est lue (delayMs 60s…) — trop lent pour un test ;
    // on écrit une config de test via l'env ? Non : loadPresenceConfig lit le
    // fichier de l'instance. On teste donc uniquement les invariants
    // synchrones : l'état ne bascule PAS immédiatement sur un exit, et un
    // enter pendant la fenêtre annule la confirmation.
    {
        const m = new TestManager();
        // seed manuel : simule un état home
        (m as any).state = 'home';
        const events: string[] = [];
        m.onEvent((e) => events.push(e));

        const after = m.handleGeofence('exit');
        assert.strictEqual(
            after,
            'home',
            "un EXIT ne bascule plus l'état immédiatement",
        );
        assert.deepStrictEqual(
            events,
            [],
            'aucun event departure avant confirmation',
        );

        // ENTER pendant la fenêtre → annulation, l'état reste home.
        m.handleGeofence('enter');
        await wait(50);
        assert.strictEqual((m as any).state, 'home');
        assert.deepStrictEqual(events, [], 'départ annulé, jamais émis');
    }
}

async function run(): Promise<void> {
    await testGuard();
    await testManagerWiring();
    console.log('All departureGuard tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
