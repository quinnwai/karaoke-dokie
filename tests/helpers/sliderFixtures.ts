// Song lists shaped like the ones the results sliders run on (QWW-33).
//
// The scores are the real ones: songs are matched, scored and ranked by the production code
// (`productionSongDeps`, `recommendCatalogue`, `buildLibrary`), so a change to the scoring changes
// these lists too. Only the inputs are invented, from a seeded generator, and shaped to reproduce
// what the preview showed:
//
// - A wide range (F2 to C5, E2 to E5) fits almost every catalogue song, and the phone gets only the
//   best 1,000 by Top picks, so difficulty bunches under 0.4 and none are past the middle.
// - Most of a library is saved-only songs, which all share one familiarity score (0.15), then the
//   playlist songs share another (0.4 or 0.45).
// - Karaoke popularity bunches between about 0.5 and 0.9 (median 0.70, 90th percentile 0.86).

import type { Match, SongRange, Track, VocalRange } from '../../src/lib/contracts';
import { catalogueTracks, recommendCatalogue, type CatalogueEntry } from '../../src/lib/server/catalogue';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { MAX_ALL_MATCHES } from '../../src/lib/server/songService';
import { buildLibrary } from '../../src/lib/server/spotify';
import { productionSongDeps } from '../../src/lib/server/wiring';
import { UNKNOWN_POPULARITY, withKaraokePopularity } from '../../src/lib/songs/score';

/** A KaraFun song's karaoke views at the 99th percentile (Oct 2026), to make up plausible view counts. */
const KARAOKE_VIEWS_TOP = 5_500_000;

const deps = productionSongDeps(createMemoryStore(), false);

/** The two ranges the preview was measured on. MIDI: C4 = 60, so F2 = 41, C5 = 72, E2 = 40, E5 = 76. */
export const F2_TO_C5: VocalRange = { low: 41, high: 72, source: 'test' };
export const E2_TO_E5: VocalRange = { low: 40, high: 76, source: 'test' };

/** Small seeded PRNG (mulberry32), so a failure reproduces. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** A standard normal draw (Box-Muller). */
const gauss = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

/** Share of sung time on each pitch: a bell around the song's middle note, with a little everywhere. */
function pitchShare(low: number, high: number, middle: number): [number, number][] {
  const sigma = Math.max(1, (high - low) / 4.5);
  const weights: [number, number][] = [];
  for (let m = low; m <= high; m++) weights.push([m, Math.exp(-0.5 * ((m - middle) / sigma) ** 2) + 0.01]);
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  return weights.map(([m, w]) => [m, w / total]);
}

/** One invented song: its range and whatever popularity data it has. */
interface Shape {
  range: SongRange;
  usdbViews?: number;
  usdbRating?: number;
  karaokeViews?: number;
  chartRank?: number;
}

function shape(rand: () => number, confidence: 'high' | 'low' = 'high'): Shape {
  // A low voice's song or a high voice's, mostly sung around its middle note.
  const middle = Math.round(clamp((rand() < 0.5 ? 53 : 62) + 3.5 * gauss(rand), 40, 76));
  // From the lowest to the highest note: mostly an octave to an octave and a half.
  const span = Math.round(clamp(7 + 3 * (-Math.log(1 - rand()) - Math.log(1 - rand())), 7, 26));
  const low = middle - Math.round(span * (0.3 + 0.4 * rand()));
  const high = low + span;
  const noteFile = confidence === 'high' && rand() < 0.7;
  const range: SongRange = {
    low,
    high,
    tessitura: middle,
    source: confidence === 'low' ? 'artist-typical' : noteFile ? 'note-file' : 'audio-full',
    confidence,
    fastLyrics: rand() < 0.15,
  };
  if (noteFile) range.pitchShare = pitchShare(low, high, middle);

  const out: Shape = { range };
  // Most songs have a USDB row; about half have karaoke views, whose scores bunch around 0.7; a few
  // are on a Billboard Year-End list. Some songs have none of these, so their popularity is unknown.
  if (rand() < 0.8) {
    out.usdbViews = Math.round(10 ** (2 + 3 * rand()));
    out.usdbRating = Math.round((3 + 2 * rand()) * 10) / 10;
  }
  if (rand() < 0.55) {
    const score = clamp(0.7 + 0.12 * gauss(rand), 0.2, 1);
    out.karaokeViews = Math.round(10 ** (score * Math.log10(KARAOKE_VIEWS_TOP)) - 1);
  }
  if (rand() < 0.08) out.chartRank = 1 + Math.floor(rand() * 100);
  return out;
}

const keyOf = (artist: string, title: string) => `${artist}|${title}`.toLowerCase();

/** Share of songs with no popularity data at all. */
const UNKNOWN_POPULARITY_SHARE = 0.2;

/**
 * Real lists carry songs we know nothing about for popularity. Ranking would mostly cut them, so a
 * share of the finished list is marked that way instead, keeping the order the server gave.
 */
function withSomeUnknownPopularity(matches: Match[], rand: () => number): Match[] {
  return matches.map((m) =>
    m.parts && rand() < UNKNOWN_POPULARITY_SHARE
      ? { ...m, parts: { ...m.parts, popularity: UNKNOWN_POPULARITY, popularityKnown: false } }
      : m,
  );
}

/**
 * What the phone receives without Spotify: the catalogue matched to `user`, ranked by Top picks and
 * cut to the best 1,000. `songs` invented catalogue songs are read most-viewed first, as the store
 * lists them, so a song's play rank is its place in that order.
 */
export function catalogueMatches(user: VocalRange, seed = 7, songs = 4000): Match[] {
  const rand = rng(seed);
  const entries: CatalogueEntry[] = [];
  for (let i = 0; i < songs; i++) {
    const s = shape(rand);
    const artist = `Artist ${i % 700}`;
    const title = `Song ${i}`;
    const key = keyOf(artist, title);
    const entry: CatalogueEntry = {
      key,
      artist,
      title,
      range: s.range,
      log: { trackId: '', title, artist, outcome: s.range.source, reason: 'Invented for a test.', at: '2026-11-05T00:00:00.000Z' },
    };
    if (s.usdbViews !== undefined) entry.usdb = { id: i, key, artist, title, views: s.usdbViews, rating: s.usdbRating };
    if (s.karaokeViews !== undefined || s.chartRank !== undefined) {
      entry.popularity = {
        key,
        source: 'karafun+billboard',
        ...(s.karaokeViews !== undefined ? { karaokeViews: s.karaokeViews } : {}),
        ...(s.chartRank !== undefined ? { chartRank: s.chartRank } : {}),
      };
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (b.usdb?.views ?? -1) - (a.usdb?.views ?? -1));
  return withSomeUnknownPopularity(recommendCatalogue(catalogueTracks(entries), user, deps, { all: true }).matches, rand);
}

const track = (i: number): Track => ({
  id: `t${i}`,
  title: `Song ${i}`,
  artist: `Artist ${i % 700}`,
  artistId: `a${i % 700}`,
  spotifyUrl: `https://open.spotify.com/track/t${i}`,
  playRank: 0,
});

/**
 * What the phone receives for a signed-in singer with a library shaped like a real one: 2,000 saved
 * songs (newest first), 400 playlist songs (150 of them also saved), three top-50 lists and the last
 * 50 plays. About three in four songs are saved and nothing else, so they share one familiarity
 * score. `buildLibrary` gives each song its familiarity, `known` and play rank, as the server does.
 * Three in ten songs have a confident range and one in ten an artist estimate (Maybe), so the
 * Maybe songs are not cut by the 1,000 limit.
 */
export function libraryMatches(user: VocalRange, seed = 11): Match[] {
  const rand = rng(seed);
  const pick = (n: number, below: number) => {
    const chosen = new Set<number>();
    while (chosen.size < n) chosen.add(Math.floor(rand() * below));
    return [...chosen].map(track);
  };
  const short = pick(50, 400);
  const top = { short_term: short, medium_term: pick(50, 800), long_term: pick(50, 1500) };
  const recent = Array.from({ length: 50 }, () => short[Math.floor(rand() * short.length)]!);
  const saved = Array.from({ length: 2000 }, (_, i) => track(i));
  const playlists = Array.from({ length: 400 }, (_, i) => track(1850 + i));
  const library = buildLibrary({ top, recent, saved, playlists });

  const matches: Match[] = [];
  for (const t of library) {
    const roll = rand();
    if (roll >= 0.4) continue; // no range data for this song
    const s = shape(rand, roll < 0.3 ? 'high' : 'low');
    const scored = withKaraokePopularity(
      { ...s.range, ...(s.usdbViews !== undefined ? { usdbViews: s.usdbViews, usdbRating: s.usdbRating } : {}) },
      { karaokeViews: s.karaokeViews, chartRank: s.chartRank },
    );
    const m = deps.matchSong(t, scored, user);
    if (m) matches.push({ ...m, range: s.range });
  }
  return withSomeUnknownPopularity(deps.rankMatches(matches).slice(0, MAX_ALL_MATCHES), rand);
}
