import assert from 'assert';
import {
    geofenceTransition,
    evaluateNetworkPresence,
    networkPresenceSignals,
} from './presence';

const MAC = '2e:9d:2b:bc:a7:1c';

function run(): void {
    // ── geofence transitions ────────────────────────────────────────────────
    assert.deepStrictEqual(geofenceTransition('away', 'enter'), {
        next: 'home',
        event: 'arrival',
    });
    assert.deepStrictEqual(geofenceTransition('unknown', 'enter'), {
        next: 'home',
        event: 'arrival',
    });
    assert.deepStrictEqual(geofenceTransition('home', 'enter'), {
        next: 'home',
        event: null,
    });
    assert.deepStrictEqual(geofenceTransition('home', 'exit'), {
        next: 'away',
        event: 'departure',
    });
    assert.deepStrictEqual(geofenceTransition('away', 'exit'), {
        next: 'away',
        event: null,
    });
    assert.deepStrictEqual(geofenceTransition('home', 'wat'), {
        next: 'home',
        event: null,
    });

    // ── evaluateNetworkPresence ─────────────────────────────────────────────
    const fresh = 15 * 60_000; // 15 min

    // ARP reachable → present (vérité temps réel, même sans bail)
    assert.strictEqual(
        evaluateNetworkPresence({
            phoneMac: MAC,
            arp: { 'mac-address': MAC.toUpperCase(), status: 'reachable' },
            lease: null,
            dhcpFreshnessMs: fresh,
        }),
        true,
        'ARP reachable should be present',
    );

    // DHCP bound + last-seen récent → present (survit au WiFi power-save)
    assert.strictEqual(
        evaluateNetworkPresence({
            phoneMac: MAC,
            arp: { 'mac-address': MAC, status: 'stale' },
            lease: {
                'mac-address': MAC,
                status: 'bound',
                'last-seen': '2m10s',
            },
            dhcpFreshnessMs: fresh,
        }),
        true,
        'DHCP bound + last-seen frais should be present',
    );

    // LE BUG : DHCP bound mais last-seen périmé (23m) + ARP failed → ABSENT
    assert.strictEqual(
        evaluateNetworkPresence({
            phoneMac: MAC,
            arp: { 'mac-address': MAC, status: 'failed' },
            lease: {
                'mac-address': MAC,
                status: 'bound',
                'last-seen': '23m31s',
            },
            dhcpFreshnessMs: fresh,
        }),
        false,
        'DHCP bound mais bail périmé ne doit PAS être présent',
    );

    // bail bound sans last-seen → considéré périmé (pas de faux positif)
    assert.strictEqual(
        evaluateNetworkPresence({
            phoneMac: MAC,
            arp: { 'mac-address': MAC, status: 'failed' },
            lease: { 'mac-address': MAC, status: 'bound' },
            dhcpFreshnessMs: fresh,
        }),
        false,
        'bail bound sans last-seen ne doit pas être présent',
    );

    // mauvais MAC → absent
    assert.strictEqual(
        evaluateNetworkPresence({
            phoneMac: MAC,
            arp: { 'mac-address': 'aa:bb:cc:dd:ee:ff', status: 'reachable' },
            lease: {
                'mac-address': 'aa:bb:cc:dd:ee:ff',
                status: 'bound',
                'last-seen': '1m',
            },
            dhcpFreshnessMs: fresh,
        }),
        false,
        'MAC qui ne matche pas → absent',
    );

    // rien → absent
    assert.strictEqual(
        evaluateNetworkPresence({
            phoneMac: MAC,
            arp: null,
            lease: null,
            dhcpFreshnessMs: fresh,
        }),
        false,
        'aucune donnée → absent',
    );

    // ── Garde de départ : fraîcheur DHCP RELATIVE à l'exit ──────────────────
    // Le bail est statique et renouvelé toutes les 15 min : à la 1re vérif
    // (exit + 60 s) `last-seen` est presque toujours < 15 min même si le
    // téléphone est parti. Seul un `last-seen` postérieur à l'exit prouve
    // quelque chose → la fenêtre est `now - exitAt`, pas 15 min.
    const sinceExit = 60_000; // 1re vérif, 60 s après l'exit

    // Exit à T, bail vu T − 11,5 min, ARP stale → ABSENT (départ réel)
    assert.strictEqual(
        evaluateNetworkPresence({
            phoneMac: MAC,
            arp: { 'mac-address': MAC, status: 'stale' },
            lease: {
                'mac-address': MAC,
                status: 'bound',
                'last-seen': '11m30s',
            },
            dhcpFreshnessMs: sinceExit,
        }),
        false,
        "bail vu AVANT l'exit ne doit pas compter comme présent",
    );

    // Exit à T, bail vu T + 20 s (last-seen 40 s à la vérif) → PRÉSENT
    assert.strictEqual(
        evaluateNetworkPresence({
            phoneMac: MAC,
            arp: { 'mac-address': MAC, status: 'stale' },
            lease: {
                'mac-address': MAC,
                status: 'bound',
                'last-seen': '40s',
            },
            dhcpFreshnessMs: sinceExit,
        }),
        true,
        "bail vu APRÈS l'exit = téléphone toujours là",
    );

    // Les signaux détaillés : lequel a conclu « présent »
    assert.deepStrictEqual(
        networkPresenceSignals({
            phoneMac: MAC,
            arp: { 'mac-address': MAC, status: 'reachable' },
            lease: {
                'mac-address': MAC,
                status: 'bound',
                'last-seen': '11m30s',
            },
            dhcpFreshnessMs: sinceExit,
        }),
        { present: true, signal: 'arp', lastSeenMs: 690_000 },
    );
    assert.deepStrictEqual(
        networkPresenceSignals({
            phoneMac: MAC,
            arp: { 'mac-address': MAC, status: 'stale' },
            lease: {
                'mac-address': MAC,
                status: 'bound',
                'last-seen': '40s',
            },
            dhcpFreshnessMs: sinceExit,
        }),
        { present: true, signal: 'dhcp', lastSeenMs: 40_000 },
    );
    assert.deepStrictEqual(
        networkPresenceSignals({
            phoneMac: MAC,
            arp: { 'mac-address': MAC, status: 'failed' },
            lease: {
                'mac-address': MAC,
                status: 'bound',
                'last-seen': '11m30s',
            },
            dhcpFreshnessMs: sinceExit,
        }),
        { present: false, signal: null, lastSeenMs: 690_000 },
    );

    console.log('All presence tests passed');
}

run();
