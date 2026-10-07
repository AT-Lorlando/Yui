import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Journal d'activité → dossier temporaire (un « Départ confirmé » y écrit).
process.env.YUI_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yui-departure-guard-'),
);

import { confirmDeparture, pingHost } from './departureGuard';
import {
    PresenceManager,
    evaluateNetworkPresence,
    type MikrotikEntry,
    type NetworkCheckResult,
} from './presence';
import type { DepartureConfirmConfig } from './presenceConfig';

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

// ── Garde : signaux réseau relatifs à l'exit + sonde ping ───────────────────
const MAC = '2e:9d:2b:bc:a7:1c';
const T = 1_800_000_000_000; // instant de l'exit (horloge simulée)

/**
 * Stub complet : horloge, config de garde (sans délais), sonde et lecture
 * ARP/DHCP simulées. `checkNetwork` applique la VRAIE règle pure avec la
 * fraîcheur que le manager lui passe — c'est ce qu'on veut vérifier.
 */
class SignalManager extends PresenceManager {
    public clock = T;
    public arp: MikrotikEntry | null = null;
    public lease: MikrotikEntry | null = null;
    public probeCalls = 0;
    public probeImpl: () => Promise<boolean> = async () => false;
    public freshnessSeen: number[] = [];
    protected override now(): number {
        return this.clock;
    }
    protected override departureConfig(): DepartureConfirmConfig {
        return { delayMs: 0, checks: 4, intervalMs: 0 };
    }
    protected override probePhone(): Promise<boolean> {
        this.probeCalls++;
        return this.probeImpl();
    }
    protected override checkNetwork(
        dhcpFreshnessMs = 900_000,
    ): Promise<NetworkCheckResult> {
        this.freshnessSeen.push(dhcpFreshnessMs);
        const present = evaluateNetworkPresence({
            phoneMac: MAC,
            arp: this.arp,
            lease: this.lease,
            dhcpFreshnessMs,
        });
        return Promise.resolve({ present });
    }
}

function homeManager(): { m: SignalManager; events: string[] } {
    const m = new SignalManager();
    (m as any).state = 'home';
    const events: string[] = [];
    m.onEvent((e) => events.push(e));
    return { m, events };
}

async function testGuardSignals(): Promise<void> {
    // Le bug du 19/09 → 07/10 : bail statique vu T − 11,5 min (renouvellement
    // DHCP toutes les 15 min), ARP stale → la garde doit CONFIRMER le départ.
    {
        const { m, events } = homeManager();
        m.arp = { 'mac-address': MAC, status: 'stale' };
        m.lease = {
            'mac-address': MAC,
            status: 'bound',
            'last-seen': '11m30s',
        };
        m.handleGeofence('exit');
        m.clock = T + 60_000; // 1re vérif, 60 s après l'exit
        await wait(50);
        assert.strictEqual(m.getState(), 'away', 'départ confirmé');
        assert.deepStrictEqual(events, ['departure']);
        assert.strictEqual(m.probeCalls, 4, 'une sonde par vérification');
        assert.deepStrictEqual(
            m.freshnessSeen,
            [60_000, 60_000, 60_000, 60_000],
            "fraîcheur DHCP = temps écoulé depuis l'exit, pas 15 min",
        );
    }
    // Bail renouvelé T + 20 s (last-seen 40 s à la vérif) → VETO.
    {
        const { m, events } = homeManager();
        m.arp = { 'mac-address': MAC, status: 'stale' };
        m.lease = { 'mac-address': MAC, status: 'bound', 'last-seen': '40s' };
        m.handleGeofence('exit');
        m.clock = T + 60_000;
        await wait(50);
        assert.strictEqual(m.getState(), 'home', 'bail post-exit → veto');
        assert.deepStrictEqual(events, []);
    }
    // Téléphone endormi mais associé (17/08) : ARP stale, la sonde le
    // réveille → ARP reachable → VETO.
    {
        const { m, events } = homeManager();
        m.arp = { 'mac-address': MAC, status: 'stale' };
        m.lease = {
            'mac-address': MAC,
            status: 'bound',
            'last-seen': '11m30s',
        };
        m.probeImpl = async () => {
            m.arp = { 'mac-address': MAC, status: 'reachable' };
            return true;
        };
        m.handleGeofence('exit');
        m.clock = T + 60_000;
        await wait(50);
        assert.strictEqual(
            m.getState(),
            'home',
            'ARP reachable après ping → veto',
        );
        assert.deepStrictEqual(events, []);
    }
    // Une sonde qui throw ne casse ni la vérification ni le verdict.
    {
        const { m, events } = homeManager();
        m.arp = { 'mac-address': MAC, status: 'failed' };
        m.lease = {
            'mac-address': MAC,
            status: 'bound',
            'last-seen': '11m30s',
        };
        m.probeImpl = async () => {
            throw new Error('ping broke');
        };
        m.handleGeofence('exit');
        m.clock = T + 60_000;
        await wait(50);
        assert.strictEqual(
            m.getState(),
            'away',
            'sonde KO → verdict réseau seul',
        );
        assert.deepStrictEqual(events, ['departure']);
    }
    // Horloge qui recule (NTP) : fraîcheur bornée à 0, jamais négative.
    {
        const { m } = homeManager();
        m.arp = null;
        m.lease = null;
        m.handleGeofence('exit');
        m.clock = T - 5_000;
        await wait(50);
        assert.ok(
            m.freshnessSeen.every((f) => f === 0),
            'fraîcheur bornée ≥ 0',
        );
    }
    // pingHost : best-effort, ne throw jamais (binaire absent, erreur, IP vide).
    {
        assert.strictEqual(await pingHost(''), false, 'IP vide → false');
        const missing = await pingHost('10.0.0.110', {
            exec: (_cmd, _args, _opts, cb) => {
                cb(new Error('spawn ping ENOENT'));
            },
        });
        assert.strictEqual(missing, false, 'binaire absent → false');
        const throwing = await pingHost('10.0.0.110', {
            exec: () => {
                throw new Error('sync boom');
            },
        });
        assert.strictEqual(throwing, false, 'exec qui throw → false');
        let seen: string[] = [];
        const ok = await pingHost('10.0.0.110', {
            exec: (cmd, args, _opts, cb) => {
                seen = [cmd, ...args];
                cb(null);
            },
        });
        assert.strictEqual(ok, true, 'ping répond → true');
        assert.deepStrictEqual(seen, [
            'ping',
            '-c',
            '1',
            '-W',
            '1',
            '10.0.0.110',
        ]);
    }
}

async function run(): Promise<void> {
    await testGuard();
    await testManagerWiring();
    await testGuardSignals();
    console.log('All departureGuard tests passed');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
