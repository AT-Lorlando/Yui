import assert from 'assert';
import { PresenceManager } from '../presence';

function run(): void {
    const pm = new PresenceManager(async () => ({ success: true }));
    const seen: string[] = [];
    pm.onChange((prev, next) => seen.push(`${prev}->${next}`));

    // setState est la méthode interne de transition (cf. Step 3)
    (pm as unknown as { setState: (s: string) => void }).setState('away');
    (pm as unknown as { setState: (s: string) => void }).setState('home');

    assert.deepStrictEqual(seen, ['unknown->away', 'away->home']);
    console.log('All presence-hook tests passed');
}

run();
