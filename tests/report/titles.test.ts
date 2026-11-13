import { describe, expect, it } from 'vitest';
import type { SongRange } from '../../src/lib/contracts';
import { createMemoryStore } from '../../src/lib/server/memoryStore';
import { productionSongDeps } from '../../src/lib/server/wiring';
import { CANONICAL_METHOD, type SongCanonical } from '../../src/lib/songs/canonical';
import { CHANGED_LISTED, TEST_RANGES, checkList, farFolded, listsBeforeAfter, maybeOnScreen, planCanonical, renderLists, summarizePlan, writePlan } from '../../src/lib/report/titles';
import { CATALOGUE_SIZE } from '../../src/lib/server/catalogue';
import type { CanonicalInput } from '../../src/lib/songs/canonical';

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

  it('lists the rows an octave apart that were folded into the better evidenced part, with the evidence behind each', async () => {
    const store = createMemoryStore();
    await add(store, "Plain White T's", 'Hey There Delilah', { source: 'audio-full', low: 52, high: 62 });
    await add(store, 'Plain White T’s', 'Hey There Delilah', { low: 64, high: 74, octaveFrom: 'recording' });
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    expect(plan.build.groups).toHaveLength(1);
    expect(plan.build.apart).toEqual([]);
    const text = summarizePlan(inputs, plan).join('\n');
    expect(text).toContain('1 groups hold rows an octave apart');
    const shown = text.split('\n').find((l) => l.includes('=>') && l.includes('52-62'))!;
    expect(shown).toContain("Plain White T's - Hey There Delilah");
    expect(shown).toContain('recording, octaveFrom none, confidence high, trust 2');
    expect(text).toContain('64-74, note file, octaveFrom recording, confidence high, trust 1');
  });

  it('lists every octave group, not a sample of ten', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 12; i++) {
      await add(store, `Artist ${i}`, 'Song', { source: 'audio-full', low: 52, high: 62 });
      await add(store, `Artist ${i}`, 'Song ', { low: 64, high: 74 });
    }
    const inputs = await store.listCanonicalInputs();
    const plan = planCanonical(inputs, new Map());
    const text = summarizePlan(inputs, plan).join('\n');
    expect(plan.build.groups.filter((g) => g.octave)).toHaveLength(12);
    expect(text).toContain('(all 12, most popular first)');
    for (let i = 0; i < 12; i++) expect(text).toContain(`Artist ${i} - Song (52-62, recording`);
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

describe('the dry run says what it would change, and what the list would show (QWW-62)', () => {
  const add = async (store: ReturnType<typeof createMemoryStore>, artist: string, title: string, r: Partial<SongRange> = {}, views = 1_000) => {
    const key = `${artist}|${title}`.toLowerCase();
    await store.putSongRange(key, { range: { ...range, ...r }, log: { trackId: '', title, artist, outcome: 'note-file', reason: '', at: '2026-11-10T00:00:00.000Z' } });
    await store.putSongPopularity([{ key, karaokeViews: views, source: 'test' }]);
    return key;
  };
  const rec = (key: string, canonicalKey: string, title: string, artist: string): SongCanonical => ({
    key, canonicalKey, title, artist, method: CANONICAL_METHOD, reason: key === canonicalKey ? 'same' : 'folded', sourceTitle: title, sourceArtist: artist,
  });
  /** The pattern of production after #44: a popular recording #44 marked low (5 semitones wide) and a confident note file at nearly the same range. */
  async function maybeSong() {
    const store = createMemoryStore();
    const recording = await add(store, "Destiny's Child", 'Lose My Breath', { source: 'audio-full', confidence: 'low', low: 63, high: 68 }, 50_000_000);
    const noteFile = await add(store, 'Destiny’s Child', 'Lose My Breath', { low: 63, high: 72 }, 1_000);
    await add(store, 'Toto', 'Africa');
    return { store, recording, noteFile };
  }
  const storedMaybe = (recording: string, noteFile: string) =>
    new Map([rec(recording, recording, 'Lose My Breath', "Destiny's Child"), rec(noteFile, recording, 'Lose My Breath', "Destiny's Child"), rec('toto|africa', 'toto|africa', 'Africa', 'Toto')].map((r) => [r.key, r]));

  /** A measured row built directly, for the tests that need more rows than a store is worth filling. */
  const input = (key: string, artist: string, title: string, rank: number, extra: Partial<CanonicalInput> = {}): CanonicalInput => ({
    key, artist, title, rank, low: 41, high: 72, trust: 0, source: 'note-file', confidence: 'high', ...extra,
  });
  /** A popular low-confidence recording, a confident note file nobody has watched, and `fillers` rows between them in popularity. */
  const crowded = (fillers: number, noteExtra: Partial<CanonicalInput> = {}) => {
    const recording = input('a|song', 'A', 'Song', 0.95, { low: 63, high: 68, source: 'audio-full', confidence: 'low' });
    const noteFile = input('a|song ', 'A', 'Song ', 0.05, { low: 63, high: 72, ...noteExtra });
    const rows = Array.from({ length: fillers }, (_, i) => input(`f${i}|s`, `F${i}`, 'S', 0.5 + i / 1_000_000));
    const inputs = [recording, noteFile, ...rows];
    const shownNoteFile = [rec(recording.key, noteFile.key, 'Song', 'A'), rec(noteFile.key, noteFile.key, 'Song', 'A')];
    return { recording, noteFile, inputs, shownNoteFile };
  };

  it('finds the songs the list would show as a Maybe over a confident row: the stored mapping has one, the run leaves none', async () => {
    const { store, recording, noteFile } = await maybeSong();
    const inputs = await store.listCanonicalInputs();
    const stored = storedMaybe(recording, noteFile); // what #40's rules stored: the recording shown, the note file folded into it
    const found = maybeOnScreen(inputs, stored.values());
    expect(found.map((m) => [m.onScreen.key, m.confident.key, m.why])).toEqual([[recording, noteFile, 'the row shown is a Maybe']]);
    const plan = planCanonical(inputs, stored);
    expect(maybeOnScreen(inputs, plan.build.records)).toEqual([]);
    const text = summarizePlan(inputs, plan).join('\n');
    expect(text).toContain('a row folded into them is confident: 1 stored now, 0 after this run.');
    expect(text).toMatch(new RegExp(`stored now: Destiny's Child - Lose My Breath \\[${recording}\\] shows 63-68 \\(recording, low; popularity \\d\\.\\d\\d, catalogue position 1\\); confident: \\[${noteFile}\\] 63-72 \\(note file; popularity \\d\\.\\d\\d, catalogue position 2\\); the row shown is a Maybe`));
    expect(text).not.toContain('after this run:');
    expect(text).not.toContain('outside the');
  });

  it('counts only a Maybe on screen: a confident row shown, nothing confident to show, or no song at all is not counted', async () => {
    const { store, recording, noteFile } = await maybeSong();
    const inputs = await store.listCanonicalInputs();
    const recs = (shownKey: string) => [rec(recording, shownKey, 'Lose My Breath', "Destiny's Child"), rec(noteFile, shownKey, 'Lose My Breath', "Destiny's Child")];
    // the note file shown, the low-confidence recording folded into it: how it should be
    expect(maybeOnScreen(inputs, recs(noteFile))).toEqual([]);
    // every row low confidence: nothing confident was hidden
    const other = createMemoryStore();
    await add(other, 'B', 'Song', { source: 'audio-full', confidence: 'low', low: 50, high: 60 }, 9_000);
    await add(other, 'B', 'Song ', { source: 'audio-full', confidence: 'low', low: 51, high: 60 }, 1_000);
    const lows = await other.listCanonicalInputs();
    expect(maybeOnScreen(lows, planCanonical(lows, new Map()).build.records)).toEqual([]);
    expect(maybeOnScreen(lows, lows.map((i) => rec(i.key, lows[0]!.key, 'Song', 'B')))).toEqual([]);
    // an ordinary fold of two confident rows: the shown row is confident, so a confident row folded into it hides nothing
    const plain = createMemoryStore();
    await add(plain, 'C', 'Song', { low: 50, high: 62 }, 9_000);
    await add(plain, 'C', 'Song ', { low: 51, high: 62 }, 1_000);
    const pair = await plain.listCanonicalInputs();
    const folded = planCanonical(pair, new Map()).build;
    expect(folded.groups).toHaveLength(1);
    expect(maybeOnScreen(pair, folded.records)).toEqual([]);
    // a record whose row is not among the inputs, or a mapping with nothing folded, is nothing
    expect(maybeOnScreen(inputs, [rec('gone|row', recording, 'x', 'y')])).toEqual([]);
    expect(maybeOnScreen(inputs, [])).toEqual([]);
  });

  it('lists each row it would write with what it replaces: which row was shown, which is now, and their ranges and confidence', async () => {
    const { store, recording, noteFile } = await maybeSong();
    const inputs = await store.listCanonicalInputs();
    const text = summarizePlan(inputs, planCanonical(inputs, storedMaybe(recording, noteFile))).join('\n');
    expect(text).toContain('Rows this run would write (2, all listed), with the ranges the rows have now:');
    expect(text).toContain(`  ${recording}: shown (63-68, recording, confidence low) -> folded into ${noteFile} (63-72, note file, confidence high)`);
    expect(text).toContain(`  ${noteFile}: folded into ${recording} (63-68, recording, confidence low) -> shown (63-72, note file, confidence high)`);
    expect(text).not.toContain('toto|africa: '); // unchanged rows are not listed
  });

  it('says so when nothing is stored yet, and when a record differs only in its text', async () => {
    const { store, recording, noteFile } = await maybeSong();
    const inputs = await store.listCanonicalInputs();
    const first = summarizePlan(inputs, planCanonical(inputs, new Map())).join('\n');
    expect(first).toContain('none stored yet, 0 after this run.');
    expect(first).toContain(`  ${noteFile}: not stored -> shown (63-72, note file, confidence high)`);
    const built = planCanonical(inputs, new Map()).build.records;
    const edited = new Map(built.map((r) => [r.key, r.key === recording ? { ...r, title: 'Stale title', reason: 'cleaned' as const } : r]));
    expect(summarizePlan(inputs, planCanonical(inputs, edited)).join('\n')).toContain(`  ${recording}: same row shown, title, reason differ`);
  });

  it(`lists the first ${CHANGED_LISTED} changed rows and says how many there are`, async () => {
    const store = createMemoryStore();
    const total = CHANGED_LISTED + 10;
    for (let i = 0; i < total; i++) await add(store, `Artist ${i}`, 'Song');
    const inputs = await store.listCanonicalInputs();
    const text = summarizePlan(inputs, planCanonical(inputs, new Map())).join('\n');
    expect(text).toContain(`Rows this run would write (${total}, the first ${CHANGED_LISTED} listed), with the ranges the rows have now:`);
    expect(text.split('\n').filter((l) => l.includes(': not stored -> shown'))).toHaveLength(CHANGED_LISTED);
  });

  describe('the rows the app reads: its most popular CATALOGUE_SIZE and every Year-End row', () => {
    it('keeps the Maybe on screen when the confident row ranks outside them, says which, and lists it after the run', () => {
      const { recording, noteFile, inputs, shownNoteFile } = crowded(CATALOGUE_SIZE);
      const stored = new Map([rec(recording.key, recording.key, 'Song', 'A'), rec(noteFile.key, recording.key, 'Song', 'A')].map((r) => [r.key, r]));
      // the mapping shows the confident note file, but the app does not read it, so the first row of the song it does read stays: the recording
      const after = maybeOnScreen(inputs, shownNoteFile);
      expect(after.map((m) => [m.onScreen.key, m.confident.key])).toEqual([[recording.key, noteFile.key]]);
      expect(after[0]!.why).toContain('outside the rows the app reads');
      const text = summarizePlan(inputs, planCanonical(inputs, stored)).join('\n');
      expect(text).toContain('1 stored now, 1 after this run (each listed below');
      expect(text).toContain(`confident: [${noteFile.key}] 63-72 (note file; popularity 0.05, catalogue position ${CATALOGUE_SIZE + 2}, outside the ${CATALOGUE_SIZE} read); the row shown is outside the rows the app reads`);
      expect(text).toContain('after this run: A - Song [a|song] shows 63-68 (recording, low; popularity 0.95, catalogue position 1)');
    });

    it('reads the row at exactly the cut and not the one after it', () => {
      // the note file's position is the fillers above it, the recording and itself: CATALOGUE_SIZE for 5,998 fillers
      const atCut = crowded(CATALOGUE_SIZE - 2);
      expect(maybeOnScreen(atCut.inputs, atCut.shownNoteFile)).toEqual([]);
      const pastCut = crowded(CATALOGUE_SIZE - 1);
      expect(maybeOnScreen(pastCut.inputs, pastCut.shownNoteFile)).toHaveLength(1);
    });

    it('reads a Year-End row whatever its rank, as the catalogue does', () => {
      const { inputs, shownNoteFile } = crowded(CATALOGUE_SIZE, { charted: true });
      expect(maybeOnScreen(inputs, shownNoteFile)).toEqual([]);
      const text = summarizePlan(inputs, planCanonical(inputs, new Map())).join('\n');
      expect(text).not.toContain('after this run: A - Song');
    });

    it('shows the better ranked of the rows it reads when the row shown is not read, and no song at all when it reads none', () => {
      // the row shown (a confident note file) is not read; of the two folded rows the app does read, the more popular shows
      const shown = input('a|song s', 'A', 'Song', 0.01);
      const lowRow = input('a|song l', 'A', 'Song', 0.9, { confidence: 'low', source: 'audio-full' });
      const okRow = input('a|song k', 'A', 'Song', 0.8);
      const fillers = Array.from({ length: CATALOGUE_SIZE }, (_, i) => input(`f${i}|s`, `F${i}`, 'S', 0.5 + i / 1_000_000));
      const all = [shown, lowRow, okRow, ...fillers];
      const song = [rec(shown.key, shown.key, 'Song', 'A'), rec(lowRow.key, shown.key, 'Song', 'A'), rec(okRow.key, shown.key, 'Song', 'A')];
      expect(maybeOnScreen(all, song).map((m) => m.onScreen.key)).toEqual([lowRow.key]); // the low-confidence row ranks first among those read
      const confidentFirst = all.map((r) => (r.key === lowRow.key ? { ...r, rank: 0.7 } : r)); // now the confident row is the better ranked: it shows
      expect(maybeOnScreen(confidentFirst, song)).toEqual([]);
      // every row of the song outside the read: the song is not on the list, so it is not a Maybe on it
      const none = [input('b|s', 'B', 'S', 0.01, { confidence: 'low' }), input('b|s ', 'B', 'S ', 0.02), ...fillers];
      expect(maybeOnScreen(none, [rec('b|s', 'b|s', 'S', 'B'), rec('b|s ', 'b|s', 'S', 'B')])).toEqual([]);
    });
  });

  it('says so when a build leaves a Maybe shown, which the rule must never do', () => {
    const recording = input('a|song', 'A', 'Song', 0.9, { low: 63, high: 68, source: 'audio-full', confidence: 'low' });
    const noteFile = input('a|song ', 'A', 'Song ', 0.3, { low: 63, high: 72 });
    const inputs = [recording, noteFile];
    const bad = [rec(recording.key, recording.key, 'Song', 'A'), rec(noteFile.key, recording.key, 'Song', 'A')];
    const plan = planCanonical(inputs, new Map());
    const text = summarizePlan(inputs, { ...plan, build: { ...plan.build, records: bad } }).join('\n'); // a build that forgot the rule
    expect(text).toContain('none stored yet, 1 after this run (each listed below');
    expect(text).toContain(`after this run: A - Song [${recording.key}] shows 63-68`);
    expect(text).toContain('the row shown is a Maybe');
  });

  it('names the same confident row in every order the stored rows come in', () => {
    const low = input('a|song', 'A', 'Song', 0.9, { low: 50, high: 60, source: 'audio-full', confidence: 'low' });
    const b = input('a|song b', 'A', 'Song', 0.4, { low: 50, high: 60 });
    const a = input('a|song a', 'A', 'Song', 0.3, { low: 50, high: 60 });
    const inputs = [low, b, a];
    const records = [rec(low.key, low.key, 'Song', 'A'), rec(b.key, low.key, 'Song', 'A'), rec(a.key, low.key, 'Song', 'A')];
    for (const order of [records, [...records].reverse(), [records[2]!, records[0]!, records[1]!]]) {
      expect(maybeOnScreen(inputs, order).map((m) => m.confident.key)).toEqual([a.key]); // the lowest key, whatever the order
    }
  });

  it('counts rows hidden behind a row shown more than 4 semitones away, and lists the ones a run newly puts there', () => {
    // The head is a low-confidence recording, so the rule shows the confident note file C: X sits within 4 of the head but 6 from C.
    const head = input('a|song', 'A', 'Song', 0.9, { low: 63, high: 68, source: 'audio-full', confidence: 'low' });
    const c = input('a|song c', 'A', 'Song', 0.3, { low: 63, high: 72 });
    const x = input('a|song x', 'A', 'Song', 0.2, { low: 59, high: 66 });
    const inputs = [head, c, x];
    const old = new Map([rec(head.key, head.key, 'Song', 'A'), rec(c.key, head.key, 'Song', 'A'), rec(x.key, head.key, 'Song', 'A')].map((r) => [r.key, r]));
    expect(farFolded(inputs, old.values())).toEqual([]);
    const plan = planCanonical(inputs, old);
    expect(farFolded(inputs, plan.build.records)).toEqual([{ row: x, shown: c, gap: 6 }]);
    const text = summarizePlan(inputs, plan).join('\n');
    expect(text).toContain('other than an octave fold: 0 stored now, 1 after this run (a row listed below');
    expect(text).toContain(`new: A - Song [${x.key}] 59-66 is hidden behind [${c.key}] 63-72, 6 semitones off`);
    // an octave fold is that far by design, and a row 4 away or less is not counted
    const octave = [input('o|s', 'O', 'S', 0.5, { low: 52, high: 65, trust: 2 }), input('o|s ', 'O', 'S ', 0.4, { low: 64, high: 77 })];
    expect(farFolded(octave, planCanonical(octave, new Map()).build.records)).toEqual([]);
  });

  it('lists a row as new when a run moves it behind another row that is as far, not only when it was never far-folded', () => {
    // X and Y are both hidden far behind D (stored). The run keeps Y behind D and puts X behind C, which is 6 away: only X is a change worth reading
    const d = input('a|song d', 'A', 'Song', 0.9, { low: 65, high: 78 });
    const c = input('a|song c', 'A', 'Song', 0.3, { low: 63, high: 72 });
    const x = input('a|song x', 'A', 'Song', 0.2, { low: 59, high: 66 });
    const y = input('a|song y', 'A', 'Song', 0.1, { low: 58, high: 66 });
    const inputs = [d, c, x, y];
    const before = new Map([rec(d.key, d.key, 'Song', 'A'), rec(x.key, d.key, 'Song', 'A'), rec(y.key, d.key, 'Song', 'A'), rec(c.key, c.key, 'Song', 'A')].map((r) => [r.key, r]));
    expect(farFolded(inputs, before.values()).map((f) => [f.row.key, f.shown.key])).toEqual([[x.key, d.key], [y.key, d.key]]);
    const after = [rec(d.key, d.key, 'Song', 'A'), rec(x.key, c.key, 'Song', 'A'), rec(y.key, d.key, 'Song', 'A'), rec(c.key, c.key, 'Song', 'A')];
    const plan = planCanonical(inputs, before);
    const text = summarizePlan(inputs, { ...plan, build: { ...plan.build, records: after } }).join('\n');
    expect(text).toContain('other than an octave fold: 2 stored now, 2 after this run');
    expect(text).toContain(`new: A - Song [${x.key}] 59-66 is hidden behind [${c.key}]`);
    expect(text).not.toContain(`new: A - Song [${y.key}]`); // hidden behind D before and after: not new
  });
});
