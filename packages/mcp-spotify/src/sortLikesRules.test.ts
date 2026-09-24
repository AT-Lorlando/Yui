import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ALL_PLAYLISTS,
    NOSTALGIA_PLAYLIST,
    NOSTALGIA_YEARS,
    RULES,
    UNSORTED_PLAYLIST,
    classifyTrack,
    duplicateGenres,
    isNostalgic,
    yearsBefore,
} from './sortLikesRules';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (base: Date, days: number): Date =>
    new Date(base.getTime() - days * DAY_MS);

test('nostalgia cutoff: > 5 years → Nostalgie, < 5 years → not', () => {
    assert.equal(NOSTALGIA_YEARS, 5);
    const cutoff = yearsBefore(NOW, NOSTALGIA_YEARS);
    assert.equal(cutoff.toISOString(), '2021-09-06T12:00:00.000Z');

    const old = daysAgo(cutoff, 1); // 5y + 1d ago
    const recent = new Date(cutoff.getTime() + DAY_MS); // 5y - 1d ago

    assert.equal(isNostalgic(old, NOW), true);
    assert.equal(isNostalgic(recent, NOW), false);
    // ISO strings work too (that's what Spotify's added_at is)
    assert.equal(
        classifyTrack({ addedAt: old.toISOString(), genres: ['pop'] }, NOW),
        NOSTALGIA_PLAYLIST,
    );
    assert.equal(
        classifyTrack({ addedAt: recent.toISOString(), genres: ['pop'] }, NOW),
        'Pop internationale',
    );
    // nostalgia wins even over a matching genre, and applies to unmatched tracks
    assert.equal(
        classifyTrack({ addedAt: old, genres: [] }, NOW),
        NOSTALGIA_PLAYLIST,
    );
    // an unparsable date is never nostalgic
    assert.equal(
        classifyTrack({ addedAt: 'not a date', genres: ['pop'] }, NOW),
        'Pop internationale',
    );
});

test('rule order: first matching rule wins', () => {
    const recent = daysAgo(NOW, 30).toISOString();
    const cls = (genres: string[]) =>
        classifyTrack({ addedAt: recent, genres }, NOW);

    assert.equal(cls(['french rap', 'drill']), 'Rap FR');
    assert.equal(cls(['phonk', 'french rap']), 'Phonk & Dark');
    assert.equal(cls(['techno', 'stutter house']), 'Techno & Hypertechno');
    assert.equal(cls([]), UNSORTED_PLAYLIST);
    assert.equal(cls(['pop']), 'Pop internationale');
    // unknown genres only → À trier
    assert.equal(cls(['drill', 'something new']), UNSORTED_PLAYLIST);
    // matching is case/whitespace-insensitive
    assert.equal(cls(['  French RAP ']), 'Rap FR');
    // exact genre strings, not substrings ("hardcore techno" ≠ "techno")
    assert.equal(cls(['hardcore techno']), 'Hardstyle & Hardcore');
});

test('every genre appears in at most one rule', () => {
    const dups = duplicateGenres(RULES);
    assert.deepEqual(
        [...dups.entries()],
        [],
        `ambiguous genres: ${[...dups]
            .map(([g, p]) => `"${g}" in ${p.join(' + ')}`)
            .join('; ')}`,
    );
});

test('rule table is well-formed', () => {
    const names = RULES.map((r) => r.playlist);
    assert.equal(
        new Set(names).size,
        names.length,
        'duplicate playlist names in RULES',
    );
    for (const rule of RULES) {
        assert.ok(rule.playlist.trim(), 'empty playlist name');
        assert.ok(rule.genres.length > 0, `${rule.playlist} has no genres`);
        for (const g of rule.genres)
            assert.equal(
                g,
                g.trim().toLowerCase(),
                `genre "${g}" in ${rule.playlist} is not normalised`,
            );
    }
    assert.ok(
        !names.includes(NOSTALGIA_PLAYLIST) &&
            !names.includes(UNSORTED_PLAYLIST),
    );
    assert.equal(ALL_PLAYLISTS.length, RULES.length + 2);
    assert.equal(ALL_PLAYLISTS[0], NOSTALGIA_PLAYLIST);
    assert.equal(ALL_PLAYLISTS[ALL_PLAYLISTS.length - 1], UNSORTED_PLAYLIST);
});
