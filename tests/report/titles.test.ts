import { describe, expect, it } from 'vitest';
import type { SongRange } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { productionSongDeps } from '../../src/lib/server/wiring';
import { CANONICAL_METHOD } from '../../src/lib/songs/canonical';
import { TEST_RANGES, checkList, listsBeforeAfter, planCanonical, renderLists, summarizePlan, writePlan } from '../../src/lib/report/titles';

const range: SongRange = { low: 55, high: 67, tessitura: 61, source: 'note-file', confidence: 'high', fastLyrics: false };

/** A small catalogue with each problem in it: one song under two spellings, tagged titles, a duet copy, an instrumental. */
async function stocked() {
  const store = createMemoryStore();
  const songs: [string, string, number][] = [
    ['Aaliyah', "I Don't Wanna", 1_000],
    ['Aaliyah', 'I Don’t Wanna', 40_000_000],
    ['10cc', 'Dreadlock Holiday (Album Version)', 30_000_000],
    ['Aqua', 'Barbie Girl [DUET]', 20_000_000],
    ['Aqua', 'Barbie Girl', 10_000_000],
    ['Kate Bush', 'Running Up That Hill (A Deal With God)', 35_000_000],
    ['Toto', 'Africa', 39_000_000],
    ['Toto', 'Africa (Instrumental)', 1],
  ];
  for (const [artist, title, views] of songs) {
    const key = `${artist}|${title}`.toLowerCase();
    await store.putSongRange(key, { range, log: { trackId: '', title, artist, outcome: 'note-file', reason: 'Measured.', at: '2026-11-10T00:00:00.000Z' } });
    await store.putSongPopularity([{ key, karaokeViews: views, source: 'test' }]);
  }
  return store;
}

describe('planCanonical and writePlan: a build that can be stopped and run again', () => {
  it('writes every row the first time, and nothing the second', async () => {
    const store = await stocked();
    const inputs = await store.listCanonicalInputs();
    const first = planCanonical(inputs, await store.listSongCanonical());
    expect(first.build.records).toHaveLength(8);
    expect(first.changed).toHaveLength(8);
    await writePlan(store, first);
    expect((await store.listSongCanonical()).size).toBe(8);
    const second = planCanonical(inputs, await store.listSongCanonical());
    expect(second.changed).toEqual([]);
    expect(second.unchanged).toBe(8);
  });

  it('finishes a run that stopped partway: the next plan holds only what is missing', async () => {
    const store = await stocked();
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    let writes = 0;
    const flaky = {
      putSongCanonical: async (rows: Parameters<typeof store.putSongCanonical>[0]) => {
        if (++writes === 3) throw new Error('connection reset');
        await store.putSongCanonical(rows);
      },
    };
    await expect(writePlan(flaky, plan, { batch: 2 })).rejects.toThrow('connection reset');
    const stored = await store.listSongCanonical();
    expect(stored.size).toBe(4); // two batches of two
    const resumed = planCanonical(inputs, stored);
    expect(resumed.changed.map((r) => r.key)).toEqual(plan.changed.slice(4).map((r) => r.key));
    await writePlan(store, resumed, { batch: 2 });
    expect(planCanonical(inputs, await store.listSongCanonical()).changed).toEqual([]);
  });

  it('rewrites rows an older version of the rules wrote, and rows whose song changed', async () => {
    const store = await stocked();
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    const old = new Map(plan.build.records.map((r) => [r.key, { ...r, method: 'titles-v0' }]));
    expect(planCanonical(inputs, old).changed).toHaveLength(8);
    const edited = new Map(plan.build.records.map((r) => [r.key, r]));
    const some = plan.build.records.find((r) => r.reason === 'cleaned')!;
    edited.set(some.key, { ...some, title: 'Stale title' });
    expect(planCanonical(inputs, edited).changed.map((r) => r.key)).toEqual([some.key]);
  });

  it.each(['canonicalKey', 'title', 'artist', 'reason', 'method', 'sourceTitle', 'sourceArtist'] as const)('a row differing in %s alone is rewritten, so a rerun repoints a fold when the shown row changes', async (field) => {
    const store = await stocked();
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    const stored = new Map(plan.build.records.map((r) => [r.key, r]));
    const one = plan.build.records.find((r) => r.reason === 'folded')!;
    stored.set(one.key, { ...one, [field]: field === 'reason' ? 'same' : 'something else' });
    expect(planCanonical(inputs, stored).changed.map((r) => r.key)).toEqual([one.key]);
  });

  it('reports the numbers to read before writing', async () => {
    const store = await stocked();
    const inputs = await store.listCanonicalInputs();
    const text = summarizePlan(inputs, planCanonical(inputs, new Map())).join('\n');
    expect(text).toContain('8 measured songs -> 6 after folding.');
    expect(text).toContain('2 rows folded into another row of the same song, in 2 groups');
    expect(text).toContain('To write: 8 rows');
    expect(text).toContain('version 1'); // the Album Version tag
    expect(text).toContain('(A Deal With God)'); // a bracket still in a shown title, for a person to see
  });
});

describe('the list before and after the build', () => {
  it('has tagged titles and duplicates before, none after, and the same songs', async () => {
    const store = await stocked();
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    const [low, high] = [TEST_RANGES[0]!, TEST_RANGES[1]!];
    const lists = await listsBeforeAfter(store, plan.build.records, productionSongDeps(store, false), [low, high]);
    expect(lists.map((l) => l.label)).toEqual([low[0], high[0]]);
    for (const l of lists) {
      const before = checkList(l.before, 50);
      expect(before.tagged.length).toBeGreaterThan(0);
      expect(before.duplicates.length).toBeGreaterThan(0);
      const after = checkList(l.after, 50);
      expect(after.tagged).toEqual([]);
      expect(after.duplicates).toEqual([]);
      expect(l.after.map((m) => m.track.title).sort()).toEqual(['Africa', 'Barbie Girl', 'Dreadlock Holiday', 'I Don’t Wanna', 'Running Up That Hill (A Deal With God)']);
    }
  });

  it('does not call a real subtitle a tag, and says what it keeps apart for a person to judge', async () => {
    const store = createMemoryStore();
    const add = async (artist: string, title: string) => {
      const key = `${artist}|${title}`.toLowerCase();
      await store.putSongRange(key, { range, log: { trackId: '', title, artist, outcome: 'note-file', reason: '', at: '2026-11-10T00:00:00.000Z' } });
    };
    await add('Usher', 'Confessions');
    await add('Usher', 'Confessions (Part II)'); // a track of its own: kept apart, but a person may read it as the same song
    await add('Kate Bush', 'Running Up That Hill (A Deal With God)');
    const inputs = await store.listCanonicalInputs();
    const [lists] = await listsBeforeAfter(store, planCanonical(inputs, new Map()).build.records, productionSongDeps(store, false), [TEST_RANGES[1]!]);
    const after = checkList(lists!.after, 50);
    expect(after.tagged).toEqual([]); // "(A Deal With God)" is the title
    expect(after.duplicates).toEqual([]); // the rules keep them apart
    expect(after.near).toHaveLength(1); // ... and a person is shown the pair
  });

  it('renders a table of counts and the lists side by side, with changed rows marked', async () => {
    const store = await stocked();
    const inputs = await store.listCanonicalInputs();
    const lists = await listsBeforeAfter(store, planCanonical(inputs, new Map()).build.records, productionSongDeps(store, false), [TEST_RANGES[1]!]);
    const md = renderLists(lists, 8, [8]);
    expect(md).toContain('| range | top 8 before | top 8 after |');
    expect(md).toMatch(/\| high male \(C3 to C5\) \| tagged [1-9]\d*, dup [1-9]\d* \| tagged 0, dup 0 \|/);
    expect(md).toContain('**10cc - Dreadlock Holiday**');
    expect(md).toContain('10cc - Dreadlock Holiday (Album Version)');
  });

  it('reads from the store only: the mapping is never written by a dry run', async () => {
    const store = await stocked();
    const inputs = await store.listCanonicalInputs();
    await listsBeforeAfter(store, planCanonical(inputs, new Map()).build.records, productionSongDeps(store, false), [TEST_RANGES[1]!]);
    expect((await store.listSongCanonical()).size).toBe(0);
    expect(CANONICAL_METHOD).toBe('titles-v1');
  });
});

describe('the report names what the rules keep apart', () => {
  const add = async (store: ReturnType<typeof createMemoryStore>, artist: string, title: string, r: Partial<SongRange> = {}, views = 1_000) => {
    const key = `${artist}|${title}`.toLowerCase();
    await store.putSongRange(key, { range: { ...range, ...r }, log: { trackId: '', title, artist, outcome: 'note-file', reason: '', at: '2026-11-10T00:00:00.000Z' } });
    await store.putSongPopularity([{ key, karaokeViews: views, source: 'test' }]);
  };

  it('lists names whose ranges disagree: they stay two rows, and the report shows both ranges', async () => {
    const store = createMemoryStore();
    await add(store, 'Guns N’ Roses', 'Don’t Cry', { low: 50, high: 72 });
    await add(store, 'Guns N’ Roses', "Don't Cry", { low: 38, high: 60 });
    await add(store, 'Aaliyah', "I Don't Wanna");
    await add(store, 'Aaliyah', 'I Don’t Wanna');
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    expect(plan.build.groups).toHaveLength(1); // Aaliyah folded
    expect(plan.build.apart).toHaveLength(1);
    const text = summarizePlan(inputs, plan).join('\n');
    expect(text).toContain('Kept as separate rows because their ranges disagree by more than 4 semitones at either end: 1 songs (1 about an octave apart)');
    expect(text).toContain('Guns N’ Roses - Don’t Cry (50-72)');
    expect(text).toContain("Guns N’ Roses - Don't Cry (38-60)");
    expect(text).toContain('[1 octave apart]');
  });

  it('lists the rows an octave apart that were folded into the better evidenced row', async () => {
    const store = createMemoryStore();
    await add(store, "Plain White T's", 'Hey There Delilah', { source: 'audio-full', low: 52, high: 62 });
    await add(store, 'Plain White T’s', 'Hey There Delilah', { low: 64, high: 74 });
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    expect(plan.build.groups).toHaveLength(1);
    expect(plan.build.apart).toEqual([]);
    const text = summarizePlan(inputs, plan).join('\n');
    expect(text).toContain('1 groups hold rows an octave apart');
    const shown = text.split('\n').find((l) => l.includes('=>') && l.includes('52-62, recording'))!;
    expect(shown).toContain("Plain White T's - Hey There Delilah");
    expect(text).toContain('64-74, note file');
  });

  it('folds songs that differ only by a featured artist, so the report has nothing to say about them', async () => {
    const store = createMemoryStore();
    await add(store, 'Michael Jackson', "I Just Can't Stop Loving You");
    await add(store, 'Michael Jackson feat. Siedah Garrett', 'I Just Can’t Stop Loving You');
    await add(store, 'Toto', 'Africa');
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    expect(plan.build.groups).toHaveLength(1);
    expect(plan.build.apart).toEqual([]);
    expect(summarizePlan(inputs, plan).join('\n')).not.toContain('featured artist away');
  });
});
