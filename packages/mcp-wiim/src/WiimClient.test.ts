import assert from 'assert';
import { controllerFor, decodeHexMeta, parseStatus } from './WiimClient';

function run(): void {
    assert.strictEqual(
        decodeHexMeta('556E6B6E6F776E'),
        undefined,
        '"Unknown" hexifié → undefined (pas de titre)',
    );
    assert.strictEqual(
        decodeHexMeta('426F68656D69616E2052686170736F6479'),
        'Bohemian Rhapsody',
    );
    assert.strictEqual(decodeHexMeta('Pas du hex'), 'Pas du hex');
    assert.strictEqual(decodeHexMeta(''), undefined);
    assert.strictEqual(decodeHexMeta(undefined), undefined);

    // Qui pilote : Spotify Connect → Spotify, le reste → l'enceinte.
    assert.strictEqual(controllerFor('31', 'play'), 'spotify');
    assert.strictEqual(controllerFor('31', 'stop'), 'spotify');
    assert.strictEqual(controllerFor('1', 'play'), 'wiim');
    assert.strictEqual(
        controllerFor('57', 'pause'),
        'wiim',
        'mode inconnu (cast…) → enceinte',
    );
    assert.strictEqual(controllerFor('57', 'stop'), 'idle');
    assert.strictEqual(controllerFor('0', 'play'), 'idle');
    assert.strictEqual(controllerFor(undefined, 'none'), 'idle');

    // Cast : getPlayerStatus sans titre, getMetaInfo complète.
    const cast = parseStatus(
        {
            status: 'play',
            mode: '57',
            vol: '32',
            mute: '0',
            Title: '',
            Artist: '',
        },
        {
            metaData: {
                title: 'Nights',
                artist: 'Frank Ocean',
                album: 'Blonde',
                albumArtURI: 'https://i.scdn.co/image/abc',
            },
        },
    );
    assert.strictEqual(cast.controller, 'wiim');
    assert.strictEqual(cast.title, 'Nights');
    assert.strictEqual(cast.artist, 'Frank Ocean');
    assert.strictEqual(cast.album, 'Blonde');
    assert.strictEqual(cast.art, 'https://i.scdn.co/image/abc');
    assert.strictEqual(cast.volume, 32);
    assert.strictEqual(cast.mode, '57');
    assert.strictEqual(cast.source, undefined);
    // Pochette non http / « unknow » ignorées.
    const bare = parseStatus(
        { status: 'pause', mode: '31' },
        { metaData: { title: 'unknow', albumArtURI: 'un_known' } },
    );
    assert.strictEqual(bare.title, undefined);
    assert.strictEqual(bare.art, undefined);
    assert.strictEqual(bare.source, 'spotify');
    console.log('All WiimClient tests passed');
}
run();
