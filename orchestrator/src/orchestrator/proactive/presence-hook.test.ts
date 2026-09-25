import assert from 'assert';
import { PresenceManager } from '../presence';

function run(): void {
    const pm = new PresenceManager();
    const seen: string[] = [];
    pm.onChange((prev, next) => seen.push(`${prev}->${next}`));

    // setState est la méthode interne de transition (cf. Step 3)
    (pm as unknown as { setState: (s: string) => void }).setState('away');
    (pm as unknown as { setState: (s: string) => void }).setState('home');

    assert.deepStrictEqual(seen, ['unknown->away', 'away->home']);

    // Plusieurs abonnés reçoivent la même transition (le moment « retour » et
    // le connecteur `presence` s'inscrivent tous les deux) ; le désabonnement
    // ne coupe que celui qui le demande.
    const multi = new PresenceManager();
    const setState = (s: string) =>
        (multi as unknown as { setState: (s: string) => void }).setState(s);
    const a: string[] = [];
    const b: string[] = [];
    const offA = multi.onChange((prev, next) => a.push(`${prev}->${next}`));
    multi.onChange((prev, next) => b.push(`${prev}->${next}`));

    setState('away');
    assert.deepStrictEqual(a, ['unknown->away']);
    assert.deepStrictEqual(b, ['unknown->away']);

    offA();
    setState('home');
    assert.deepStrictEqual(a, ['unknown->away'], 'désabonné : plus rien');
    assert.deepStrictEqual(b, ['unknown->away', 'away->home']);

    // Un abonné qui lève ne prive pas les suivants de la transition.
    const guarded = new PresenceManager();
    const late: string[] = [];
    guarded.onChange(() => {
        throw new Error('boom');
    });
    guarded.onChange((prev, next) => late.push(`${prev}->${next}`));
    (guarded as unknown as { setState: (s: string) => void }).setState('away');
    assert.deepStrictEqual(late, ['unknown->away']);

    console.log('All presence-hook tests passed');
}

run();
