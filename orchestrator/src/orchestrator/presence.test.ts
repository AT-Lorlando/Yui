import assert from 'assert';
import { geofenceTransition, evaluateNetworkPresence } from './presence';

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

    console.log('All presence tests passed');
}

run();
