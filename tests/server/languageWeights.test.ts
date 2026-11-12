// QWW-59: logged out, German, Polish and French songs whose only popularity signal is their USDB views count half
// (score.ts LANGUAGE_POPULARITY_WEIGHTS). Checked on the real path: catalogue songs matched and scored by the production
// code (catalogue.ts), ranked by the engine (songs/setlist.ts) as POST /api/setlist and the catalogue's own list answer.

import { describe, expect, it } from 'vitest';
import type { SetlistRequest, SetlistResponse, SongRange } from '../../src/lib/contracts';
import { catalogueTracks, prepareCatalogue, recommendCatalogue, type CatalogueEntry } from '../../src/lib/server/catalogue';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { setlistFor, withLibrary } from '../../src/lib/server/setlistService';
import { productionSongDeps } from '../../src/lib/server/wiring';
import { LANGUAGE_POPULARITY_WEIGHTS, languageWeight } from '../../src/lib/songs/score';
import { libraryCandidate, prepareSetlist, rankPrepared } from '../../src/lib/songs/setlist';
import { DEFAULTS, DEFAULT_OFF } from '../../src/lib/songs/setlistConfig';

const deps = productionSongDeps(createMemoryStore(), false);
const RANGE = { low: 48, high: 72 }; // tenor; every song below fits as written, with the same notes

/** Every song has the same notes, so only popularity tells them apart. */
const NOTES: SongRange = {
  low: 55,
  high: 67,
  tessitura: 61,
  source: 'note-file',
  confidence: 'high',
  fastLyrics: false,
  pitchShare: Array.from({ length: 13 }, (_, i): [number, number] => [55 + i, 1 / 13]),
};

/** A catalogue song with its USDB language and views, and any other popularity signal. */
function entry(id: string, usdb: { views: number; language?: string }, other: { karaokeViews?: number; chartRank?: number; deezerRank?: number } = {}): CatalogueEntry {
  const key = `artist ${id}|${id}`;
  const e: CatalogueEntry = {
    key,
    artist: `Artist ${id}`,
    title: id,
    range: NOTES,
    log: { trackId: '', title: id, artist: `Artist ${id}`, outcome: 'note-file', reason: 'test', at: '2026-11-12T00:00:00.000Z' },
    usdb: { id: id.length, key, artist: `Artist ${id}`, title: id, views: usdb.views, ...(usdb.language ? { language: usdb.language } : {}) },
  };
  if (Object.keys(other).length) e.popularity = { key, source: 'karafun', ...other };
  return e;
}

const SONGS = [
  entry('de', { views: 2056, language: 'German' }), // Kreuzberger Nächte's views, and nothing else
  entry('pl', { views: 1800, language: 'Polish' }),
  entry('fr', { views: 1700, language: 'French' }),
  entry('en-a', { views: 1000, language: 'English' }),
  entry('en-b', { views: 600, language: 'English' }),
  entry('en-c', { views: 450, language: 'English' }),
  entry('es', { views: 1600, language: 'Spanish' }),
  entry('ja', { views: 1500, language: 'Japanese (romanized)' }),
  entry('none', { views: 1400 }),
  entry('de-en', { views: 1900, language: 'German, English' }), // the map names "German" only, exactly
  entry('de-deezer', { views: 2000, language: 'German' }, { deezerRank: 300_000 }),
  entry('de-karafun', { views: 2000, language: 'German' }, { karaokeViews: 50_000 }),
  entry('de-chart', { views: 2000, language: 'German' }, { chartRank: 50 }),
];
const WEIGHTED = ['de', 'pl', 'fr'];
const tracks = catalogueTracks(SONGS);
const base = prepareCatalogue(tracks, RANGE, deps);
const NO_LIBRARY = null;
const EMPTY_LIBRARY = { matches: [], keys: new Map<string, string>(), logs: new Map(), complete: true };

function request(over: Partial<SetlistRequest> = {}): SetlistRequest {
  return {
    range: RANGE,
    gears: { difficulty: DEFAULTS.difficulty, history: DEFAULTS.history, popularity: DEFAULTS.popularity, tempo: DEFAULTS.tempo },
    off: [...DEFAULT_OFF],
    eras: [...DEFAULTS.eras],
    limit: 200,
    ...over,
  };
}
const ids = (r: SetlistResponse) => r.songs.map((s) => s.match.track.title);
const song = (r: SetlistResponse, id: string) => r.songs.find((s) => s.match.track.title === id)!;
const without = (list: string[], gone: string[]) => list.filter((id) => !gone.includes(id));

describe('the language weight on the Setlist tuner (POST /api/setlist)', () => {
  const loggedOut = setlistFor(base, NO_LIBRARY, request());
  const loggedIn = setlistFor(base, EMPTY_LIBRARY, request());
  // Popularity alone, so the order is the popularity order.
  const popularityOnly = { off: [...DEFAULT_OFF, 'difficulty' as const] };

  it('moves a German song with USDB views alone down when logged out, and leaves it where it was when signed in', () => {
    expect(ids(loggedIn)[0]).toBe('de'); // the most USDB views of all
    expect(ids(loggedOut).indexOf('de')).toBeGreaterThan(ids(loggedIn).indexOf('de'));
    // Half of 0.95 is under every English song here, the least viewed (450 views) included.
    expect(ids(setlistFor(base, NO_LIBRARY, request(popularityOnly))).slice(-3).sort()).toEqual([...WEIGHTED].sort());
    // Signed in, the list is the one no weight touches.
    const unweighted = rankPrepared(base.prepared, { ...request(), loggedIn: false, languageWeights: {} });
    expect(ids(loggedIn)).toEqual(unweighted.songs.map((s) => s.match.track.title));
  });

  it('halves the popularity of German, Polish and French songs only', () => {
    for (const id of WEIGHTED) {
      expect(song(loggedOut, id).match.parts!.popularity, id).toBeCloseTo(song(loggedIn, id).match.parts!.popularity / 2, 9);
    }
    for (const id of without(ids(loggedIn), WEIGHTED)) {
      expect(song(loggedOut, id).match.parts!.popularity, id).toBe(song(loggedIn, id).match.parts!.popularity);
    }
  });

  it('does not move the same German song when it has a Deezer rank, KaraFun views or a chart entry', () => {
    for (const id of ['de-deezer', 'de-karafun', 'de-chart']) {
      expect(song(loggedOut, id).match.parts!.popularity, id).toBe(song(loggedIn, id).match.parts!.popularity);
      expect(song(loggedOut, id).match.reasons, id).toEqual(song(loggedIn, id).match.reasons);
    }
    // Every song that is not weighted keeps its order among the others.
    expect(without(ids(loggedOut), WEIGHTED)).toEqual(without(ids(loggedIn), WEIGHTED));
  });

  it('does not move a Spanish or Japanese song, a song with no language, or one listed as "German, English"', () => {
    for (const id of ['es', 'ja', 'none', 'de-en']) {
      expect(song(loggedOut, id).match.parts!.popularity, id).toBe(song(loggedIn, id).match.parts!.popularity);
      expect(song(loggedOut, id).match.reasons, id).toEqual(song(loggedIn, id).match.reasons);
    }
  });

  it('puts the song on the Popularity gear and gives it the "Crowd favourite" reason by the weighted score', () => {
    const before = song(loggedIn, 'de');
    const after = song(loggedOut, 'de');
    expect(before.match.reasons).toContain('Crowd favourite');
    expect(after.match.reasons).not.toContain('Crowd favourite');
    expect(before.match.score).toBeGreaterThan(after.match.score!);
    // Its place is now below every English song's, the least viewed included; signed in it was the highest of all.
    expect(before.gears.popularity).toBe(100);
    for (const id of ['en-a', 'en-b', 'en-c']) expect(after.gears.popularity!, id).toBeLessThan(song(loggedOut, id).gears.popularity!);
    // A Spanish song keeps its reason, and moves up a place for each weighted song that fell below it.
    expect(song(loggedOut, 'es').match.reasons).toContain('Crowd favourite');
    expect(song(loggedOut, 'es').gears.popularity!).toBeGreaterThan(song(loggedIn, 'es').gears.popularity!);
  });

  it('leaves the shared list for the range as it was, so the next request starts from the same songs', () => {
    const before = JSON.stringify(base.prepared);
    setlistFor(base, NO_LIBRARY, request());
    expect(JSON.stringify(base.prepared)).toBe(before);
  });

  it('applies to the catalogue songs of a signed-in list when the map is passed, but never to the singer\'s own songs', () => {
    // The one-line change of QWW-59's open question: the songs are already there to weigh.
    const own = base.matches.find((m) => m.track.title === 'pl')!;
    const library = { matches: [{ ...own, track: { ...own.track, id: 'spotify-pl', known: true, familiarity: 0.9 } }], keys: new Map([['spotify-pl', 'artist pl|pl']]), logs: new Map(), complete: true };
    const merged = prepareSetlist(withLibrary(base, library).candidates, RANGE);
    const ranked = rankPrepared(merged, { ...request(), loggedIn: true, languageWeights: LANGUAGE_POPULARITY_WEIGHTS });
    const popularity = (id: string) => ranked.songs.find((s) => s.match.track.id === id)!.match.parts!.popularity;
    expect(popularity('cat:artist de|de')).toBeCloseTo(song(loggedIn, 'de').match.parts!.popularity / 2, 9);
    expect(popularity('spotify-pl')).toBe(song(loggedIn, 'pl').match.parts!.popularity);
    expect(libraryCandidate(own)).not.toHaveProperty('language');
  });
});

describe('the language weight on the catalogue list (GET /api/catalogue/recommendations)', () => {
  const user = { ...RANGE, source: 'test' as const };
  const after = recommendCatalogue(tracks, user, deps, { all: true }).matches;
  const before = recommendCatalogue(tracks, user, deps, { all: true }, {}).matches;
  const by = (list: typeof after, id: string) => list.find((m) => m.track.title === id)!;
  const order = (list: typeof after) => list.map((m) => m.track.title);

  it('is always on there: German, Polish and French songs on USDB views alone move down, with their score and reason', () => {
    for (const id of WEIGHTED) {
      expect(order(after).indexOf(id), id).toBeGreaterThan(order(before).indexOf(id));
      expect(by(after, id).parts!.popularity, id).toBeCloseTo(by(before, id).parts!.popularity / 2, 9);
      expect(by(after, id).score!, id).toBeLessThan(by(before, id).score!);
      expect(by(after, id).reasons, id).not.toContain('Crowd favourite');
    }
    expect(without(order(after), WEIGHTED)).toEqual(without(order(before), WEIGHTED));
    for (const id of ['es', 'ja', 'de-deezer']) expect(by(after, id)).toEqual(by(before, id));
  });
});

describe('languageWeight', () => {
  const weights = { German: 0.5, Bad: Number.NaN, Negative: -1 };
  it('is the language\'s weight only for a song whose one signal is USDB views, in a language the map names', () => {
    expect(languageWeight({ language: 'German', usdbOnly: true }, weights)).toBe(0.5);
    expect(languageWeight({ language: 'German', usdbOnly: false }, weights)).toBe(1);
    expect(languageWeight({ language: 'German' }, weights)).toBe(1);
    expect(languageWeight({ usdbOnly: true }, weights)).toBe(1);
    expect(languageWeight({ language: 'Spanish', usdbOnly: true }, weights)).toBe(1);
    expect(languageWeight({ language: 'german', usdbOnly: true }, weights)).toBe(1); // USDB's spelling, exactly
  });
  it('counts a weight that is not a number from 0 up, or a name the map only inherits, as 1', () => {
    expect(languageWeight({ language: 'Bad', usdbOnly: true }, weights)).toBe(1);
    expect(languageWeight({ language: 'Negative', usdbOnly: true }, weights)).toBe(1);
    expect(languageWeight({ language: 'constructor', usdbOnly: true }, weights)).toBe(1);
  });
  it('names German, Polish and French at half, and not Spanish or Japanese (Quinn-Wai, 12 Nov)', () => {
    expect(LANGUAGE_POPULARITY_WEIGHTS).toEqual({ German: 0.5, Polish: 0.5, French: 0.5 });
  });
});
