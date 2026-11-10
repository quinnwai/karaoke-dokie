import { describe, expect, it } from 'vitest';
import type { KnownSongsResponse, Match } from '../../src/lib/contracts';
import { duetsAndMoodsOn, readConfig } from '../../src/lib/server/config';
import { applyDuetsAndMoods, applyDuetsToKnownSongs, withoutDuetRange, withoutDuetsAndMoods } from '../../src/lib/server/features';
import type { SongMoodsRecord } from '../../src/lib/server/store';

describe('the duets and moods switch (QWW-43)', () => {
  it('is off unless DUETS_AND_MOODS is exactly "on"', () => {
    expect(duetsAndMoodsOn({})).toBe(false);
    for (const v of ['', ' ', 'off', '0', '1', 'true', 'yes', 'onn', 'on!', 'of']) {
      expect(duetsAndMoodsOn({ DUETS_AND_MOODS: v }), JSON.stringify(v)).toBe(false);
    }
    for (const v of ['on', 'ON', ' On ']) expect(duetsAndMoodsOn({ DUETS_AND_MOODS: v }), JSON.stringify(v)).toBe(true);
  });

  it('is read by readConfig, next to the list of shipped moods, and neither depends on the other', () => {
    expect(readConfig({})).toMatchObject({ duetsAndMoods: false, moodsShipped: [] });
    expect(readConfig({ MOODS_SHIPPED: 'heartfelt' })).toMatchObject({ duetsAndMoods: false, moodsShipped: ['heartfelt'] });
    expect(readConfig({ DUETS_AND_MOODS: 'on' })).toMatchObject({ duetsAndMoods: true, moodsShipped: [] });
    expect(readConfig({ DUETS_AND_MOODS: 'on', MOODS_SHIPPED: 'upbeat,heartfelt' })).toMatchObject({
      duetsAndMoods: true,
      moodsShipped: ['upbeat', 'heartfelt'],
    });
  });
});

const duet = (): Match => ({
  track: { id: 'cat:abba|dancing queen', title: 'Dancing Queen', artist: 'ABBA', artistId: '', spotifyUrl: '', playRank: 3 },
  range: {
    low: 50,
    high: 62,
    tessitura: 56,
    source: 'note-file',
    confidence: 'high',
    fastLyrics: false,
    duet: true,
    parts: [
      { singer: 'Agnetha', low: 50, high: 62, tessitura: 56, fastLyrics: false },
      { singer: 'Frida', low: 48, high: 60, tessitura: 54, fastLyrics: false },
    ],
  },
  difficulty: 'easy',
  octave: 'none',
  score: 0.8,
  strain: 0.4,
  year: 1976,
  reasons: ['In your sweet spot'],
  part: 1,
  partSinger: 'Agnetha',
  moods: ['upbeat'],
});

function store(records: SongMoodsRecord[]) {
  const calls: string[][] = [];
  return {
    calls,
    async getSongMoods(keys: string[]) {
      calls.push(keys);
      return new Map(records.filter((r) => keys.includes(r.key)).map((r) => [r.key, r]));
    },
  };
}

describe('withoutDuetsAndMoods', () => {
  it('takes out the moods and every duet marker, and keeps everything else as it was', () => {
    const m = duet();
    const out = withoutDuetsAndMoods(m);
    expect(out).not.toHaveProperty('moods');
    expect(out).not.toHaveProperty('part');
    expect(out).not.toHaveProperty('partSinger');
    expect(out.range).not.toHaveProperty('duet');
    expect(out.range).not.toHaveProperty('parts');
    const { part: _p, partSinger: _s, moods: _m, ...rest } = m;
    const { duet: _d, parts: _ps, ...range } = m.range;
    expect(out).toEqual({ ...rest, range });
  });

  it('leaves its input alone: the matches of a catalogue response are shared with its cache', () => {
    const m = duet();
    const before = structuredClone(m);
    withoutDuetsAndMoods(m);
    expect(m).toEqual(before);
  });

  it('passes a solo song with no mood through unchanged', () => {
    const { part: _p, partSinger: _s, moods: _m, ...solo } = duet();
    const m: Match = { ...solo, range: { low: 50, high: 62, tessitura: 56, source: 'note-file', confidence: 'high', fastLyrics: false } };
    expect(withoutDuetsAndMoods(m)).toEqual(m);
  });
});

describe('withoutDuetRange and the pick-songs list', () => {
  it('takes the duet flag and the singers’ parts off a range, keeps the rest, and leaves its input alone', () => {
    const { range } = duet();
    const before = structuredClone(range);
    const out = withoutDuetRange(range);
    expect(out).not.toHaveProperty('duet');
    expect(out).not.toHaveProperty('parts');
    expect(out).toEqual({ low: 50, high: 62, tessitura: 56, source: 'note-file', confidence: 'high', fastLyrics: false });
    expect(range).toEqual(before);
  });

  const list = (): KnownSongsResponse => {
    const d = duet();
    return { songs: [{ track: d.track, range: d.range }, { track: { ...d.track, id: 't2' }, range: withoutDuetRange(d.range) }] };
  };

  it('off: every song of the list without duet markers, in the same order', () => {
    const out = applyDuetsToKnownSongs(list(), { duetsAndMoods: false });
    expect(out.songs.map((s) => s.track.id)).toEqual(['cat:abba|dancing queen', 't2']);
    for (const s of out.songs) expect(s.range).toEqual(withoutDuetRange(s.range));
    expect(out.songs[0]!.range).not.toHaveProperty('duet');
  });

  it('on: the list as it is', () => {
    const body = list();
    expect(applyDuetsToKnownSongs(body, { duetsAndMoods: true })).toBe(body);
  });
});

describe('applyDuetsAndMoods', () => {
  const record: SongMoodsRecord = { key: 'abba|dancing queen', moods: ['upbeat', 'heartfelt'], method: 'm', source: 'claude' };

  it('off: no moods, no duet markers, and no read of the mood labels', async () => {
    const s = store([record]);
    const { moods: _m, ...labelled } = duet();
    const out = await applyDuetsAndMoods([labelled], s, { duetsAndMoods: false, moodsShipped: ['upbeat', 'heartfelt'] });
    expect(out).toEqual([withoutDuetsAndMoods(labelled)]);
    expect(s.calls).toHaveLength(0);
  });

  it('off: strips a mood label that was already on the match too', async () => {
    const out = await applyDuetsAndMoods([duet()], store([record]), { duetsAndMoods: false, moodsShipped: ['upbeat'] });
    expect(out[0]).not.toHaveProperty('moods');
  });

  it('on: the shipped moods only, and the duet markers as they are', async () => {
    const s = store([record]);
    const { moods: _m, ...unlabelled } = duet();
    const [out] = await applyDuetsAndMoods([unlabelled], s, { duetsAndMoods: true, moodsShipped: ['upbeat'] });
    expect(out).toEqual({ ...unlabelled, moods: ['upbeat'] });
    expect(out!.range.duet).toBe(true);
    expect(out!.part).toBe(1);
    expect(s.calls).toHaveLength(1);
  });

  it('on, with no mood shipped: no moods, but the duets stay', async () => {
    const { moods: _m, ...unlabelled } = duet();
    const out = await applyDuetsAndMoods([unlabelled], store([record]), { duetsAndMoods: true, moodsShipped: [] });
    expect(out).toEqual([unlabelled]);
  });
});
