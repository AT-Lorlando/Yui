import assert from 'assert';
import { mergeGeofenceConfig } from './presenceConfig';

function run(): void {
    // defaults quand vide
    {
        const c = mergeGeofenceConfig({});
        assert.strictEqual(c.enabled, true);
        assert.strictEqual(c.radiusM, 150);
    }
    // valeurs fournies
    {
        const c = mergeGeofenceConfig({
            geofence: { enabled: false, radiusM: 200 },
        });
        assert.strictEqual(c.enabled, false);
        assert.strictEqual(c.radiusM, 200);
    }
    // clamp bas / haut
    {
        assert.strictEqual(
            mergeGeofenceConfig({ geofence: { radiusM: 10 } }).radiusM,
            80,
        );
        assert.strictEqual(
            mergeGeofenceConfig({ geofence: { radiusM: 9999 } }).radiusM,
            500,
        );
    }
    // radius invalide → défaut
    {
        assert.strictEqual(
            mergeGeofenceConfig({ geofence: { radiusM: 'x' } }).radiusM,
            150,
        );
    }
    console.log('All presenceConfig tests passed');
}

run();
