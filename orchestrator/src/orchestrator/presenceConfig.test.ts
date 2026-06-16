import assert from 'assert';
import { mergePresenceConfig } from './presenceConfig';

function run(): void {
    // defaults
    {
        const c = mergePresenceConfig({});
        assert.strictEqual(c.geofence.enabled, true);
        assert.strictEqual(c.geofence.radiusM, 150);
        assert.strictEqual(c.mac.burstIntervalMs, 15000);
        assert.strictEqual(c.mac.burstWindowMs, 300000);
    }
    // provided values
    {
        const c = mergePresenceConfig({
            geofence: { enabled: false, radiusM: 200 },
            mac: { burstIntervalMs: 20000, burstWindowMs: 120000 },
        });
        assert.strictEqual(c.geofence.enabled, false);
        assert.strictEqual(c.geofence.radiusM, 200);
        assert.strictEqual(c.mac.burstIntervalMs, 20000);
        assert.strictEqual(c.mac.burstWindowMs, 120000);
    }
    // clamps: radius 80..500, interval 5000..60000, window 60000..900000
    {
        assert.strictEqual(
            mergePresenceConfig({ geofence: { radiusM: 10 } }).geofence.radiusM,
            80,
        );
        assert.strictEqual(
            mergePresenceConfig({ geofence: { radiusM: 9999 } }).geofence
                .radiusM,
            500,
        );
        assert.strictEqual(
            mergePresenceConfig({ mac: { burstIntervalMs: 100 } }).mac
                .burstIntervalMs,
            5000,
        );
        assert.strictEqual(
            mergePresenceConfig({ mac: { burstIntervalMs: 999999 } }).mac
                .burstIntervalMs,
            60000,
        );
        assert.strictEqual(
            mergePresenceConfig({ mac: { burstWindowMs: 100 } }).mac
                .burstWindowMs,
            60000,
        );
        assert.strictEqual(
            mergePresenceConfig({ mac: { burstWindowMs: 9999999 } }).mac
                .burstWindowMs,
            900000,
        );
    }
    // invalid → defaults
    {
        const c = mergePresenceConfig({
            geofence: { radiusM: 'x' },
            mac: { burstIntervalMs: 'y' },
        });
        assert.strictEqual(c.geofence.radiusM, 150);
        assert.strictEqual(c.mac.burstIntervalMs, 15000);
    }
    console.log('All presenceConfig tests passed');
}

run();
