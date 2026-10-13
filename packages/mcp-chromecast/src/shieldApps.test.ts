import assert from 'assert';
import {
    buildCatalog,
    parsePackages,
    resolveApp,
    shieldLaunchTool,
} from './shieldApps';

const pm = `package:de.ozerov.fully
package:com.plexapp.android
package:com.plexapp.mediaserver.smb
package:com.google.android.tts
package:com.netflix.ninja
package:com.example.weird
`;
assert.deepStrictEqual(parsePackages(pm), [
    'de.ozerov.fully',
    'com.plexapp.android',
    'com.plexapp.mediaserver.smb',
    'com.google.android.tts',
    'com.netflix.ninja',
    'com.example.weird',
]);

// Catalogue : connus installés dans l'ordre connu, inconnus après, bruit filtré.
const cat = buildCatalog(parsePackages(pm));
assert.deepStrictEqual(
    cat.map((a) => a.id),
    ['netflix', 'plex', 'fully', 'weird'],
);
assert.strictEqual(cat[3]!.package, 'com.example.weird');
// Sans ADB : toutes les apps connues.
assert.ok(buildCatalog([]).length > 10);

// Résolution : id, libellé, alias, package, inclusion unique ; ambigu → null.
assert.strictEqual(resolveApp('netflix', cat)?.package, 'com.netflix.ninja');
assert.strictEqual(resolveApp('Dashboard', cat)?.id, 'fully');
assert.strictEqual(resolveApp('com.plexapp.android', cat)?.id, 'plex');
assert.strictEqual(resolveApp('PLEX', cat)?.id, 'plex');
const all = buildCatalog([]);
assert.strictEqual(resolveApp('disney plus', all)?.id, 'disney');
assert.strictEqual(resolveApp('amazon', all)?.id, 'prime');
assert.strictEqual(
    resolveApp('youtube', all)?.id,
    'youtube',
    'exact avant inclusion (youtube music)',
);
assert.strictEqual(
    resolveApp('music', all),
    null,
    'ambigu : YouTube Music / Amazon Music',
);
assert.strictEqual(resolveApp('', all), null);

// Outil : enum = ids du catalogue.
const tool = shieldLaunchTool(cat);
assert.strictEqual(tool.name, 'shield_launch');
assert.deepStrictEqual((tool.inputSchema.properties.app as any).enum, [
    'netflix',
    'plex',
    'fully',
    'weird',
]);
console.log('shieldApps: ok');
