import { describe, expect, it } from 'vitest';
import { CANONICAL_METHOD, MAX_RANGE_GAP, OCTAVE_TOLERANCE, applyCanonical, buildCanonical, type CanonicalInput, type SongCanonical } from '../../src/lib/songs/canonical';

let n = 0;
/** A measured song, F2 to C5 unless the test says otherwise; every row gets a unique key unless the test gives one. */
const row = (artist: string, title: string, rank = 0.5, extra: Partial<CanonicalInput> = {}): CanonicalInput => ({
  key: `${artist}|${title}`.toLowerCase() + `#${n++}`,
  artist,
  title,
  rank,
  low: 41,
  high: 72,
  trust: 0,
  ...extra,
});
/** A fixed shuffle, so a failure can be run again. */
const shuffle = <T,>(xs: T[], seed: number): T[] => {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};
const byKey = (b: ReturnType<typeof buildCanonical>) => new Map(b.records.map((r) => [r.key, r]));

describe('buildCanonical: which rows are one song', () => {
  it('folds listings that differ only in spelling, and shows the most popular of them', () => {
    const a = row('Aaliyah', "I Don't Wanna", 0.4);
    const b = row('Aaliyah', 'I Don’t Wanna', 0.6);
    const c = row('E-40', 'U and Dat', 0.5);
    const d = row('E‐40', 'U and Dat', 0.5, { key: 'e‐40|u and dat' });
    const build = buildCanonical([a, b, c, d]);
    const r = byKey(build);
    expect(r.get(b.key)).toMatchObject({ canonicalKey: b.key, title: 'I Don’t Wanna', reason: 'same' });
    expect(r.get(a.key)).toMatchObject({ canonicalKey: b.key, title: 'I Don’t Wanna', artist: 'Aaliyah', reason: 'folded' });
    // equal popularity: the lower key wins, the same in every run
    const winner = [c.key, d.key].sort()[0]!;
    expect(r.get(c.key)!.canonicalKey).toBe(winner);
    expect(r.get(d.key)!.canonicalKey).toBe(winner);
    expect(build.groups.map((g) => g.members.length)).toEqual([2, 2]);
  });

  it('shows the main version, the one with no tag on its title, and its clean title', () => {
    const main = row('10cc', 'Dreadlock Holiday', 0.8);
    const album = row('10cc', 'Dreadlock Holiday (Album Version)', 0.85);
    const duet = row('10cc', 'Dreadlock Holiday [DUET]', 0.82);
    const r = byKey(buildCanonical([album, duet, main]));
    for (const x of [main, album, duet]) expect(r.get(x.key)).toMatchObject({ canonicalKey: main.key, title: 'Dreadlock Holiday' });
    expect(r.get(main.key)!.reason).toBe('same');
    expect(r.get(album.key)!.reason).toBe('folded');
  });

  it('shows an alternate only when it is clearly more popular: 0.15 higher on the popularity score', () => {
    const main = row('A', 'Song', 0.5);
    const near = row('A', 'Song (Live)', 0.64); // 0.14 above: not clearly
    expect(byKey(buildCanonical([main, near])).get(near.key)!.canonicalKey).toBe(main.key);
    const clear = row('A', 'Song (Live)', 0.66); // 0.16 above
    const g = buildCanonical([main, clear]);
    expect(byKey(g).get(main.key)).toMatchObject({ canonicalKey: clear.key, title: 'Song', reason: 'folded' });
    expect(byKey(g).get(clear.key)).toMatchObject({ canonicalKey: clear.key, title: 'Song', reason: 'cleaned' }); // the alternate's title is clean too
    expect(g.groups[0]!.alternate).toBe(true);
    // a song nothing is known about (-1) gives way to one that is known
    expect(byKey(buildCanonical([row('A', 'Song', -1, { key: 'a|song' }), row('A', 'Song (Live)', 0.2, { key: 'a|song live' })])).get('a|song')!.canonicalKey).toBe('a|song live');
  });

  it('shows the most popular plain row, however many there are, and the most popular clear alternate over it', () => {
    // plain rows never beat one another except by popularity: the 0.97 one is shown, not a lower one
    const a = row('4 Non Blondes', 'What’s Up', 0.99);
    const b = row('4 Non Blondes', "What's Up?", 0.97);
    const c = row('4 Non Blondes', 'What’s Up?', 0.98);
    const r = byKey(buildCanonical([c, b, a]));
    for (const x of [a, b, c]) expect(r.get(x.key)!.canonicalKey).toBe(a.key);
    // two alternates clearly above the main version: the more popular of them is shown
    const main = row('A', 'Song', 0.4);
    const live = row('A', 'Song (Live)', 0.6);
    const radio = row('A', 'Song (Radio Edit)', 0.7);
    const all = byKey(buildCanonical([main, live, radio]));
    for (const x of [main, live, radio]) expect(all.get(x.key)!.canonicalKey).toBe(radio.key);
  });

  it('shows the most popular when no row is plain', () => {
    const a = row('A', 'Song (Album Version)', 0.3);
    const b = row('A', 'Song (Radio Edit)', 0.4);
    const r = byKey(buildCanonical([a, b]));
    expect(r.get(a.key)!.canonicalKey).toBe(b.key);
    expect(r.get(b.key)).toMatchObject({ title: 'Song', reason: 'cleaned' });
  });

  it('keeps apart what is not provably one song', () => {
    const rows = [
      row('Jeff Buckley', 'Hallelujah'),
      row('Leonard Cohen', 'Hallelujah'),
      row('Hall & Oates', 'Rich Girl'),
      row('Oates & Hall', 'Rich Girl'),
      row('Usher', 'Confessions Part I'),
      row('Usher', 'Confessions Part II'),
      row('Master P', "Make 'Em Say Uhh!"),
      row('Master P', "Make 'Em Say Uhh #2"),
    ];
    const build = buildCanonical(rows);
    expect(build.groups).toEqual([]);
    for (const r of build.records) expect(r.canonicalKey).toBe(r.key);
  });

  it('folds a featured artist on the title, on the artist line or missing: one lead artist and title is one song', () => {
    const a = row('Disclosure', 'Latch (feat. Sam Smith)', 0.6);
    const b = row('Disclosure feat. Sam Smith', 'Latch', 0.5);
    const c = row('Disclosure', 'Latch', 0.4);
    const r = byKey(buildCanonical([a, b, c]));
    // the main version is the most popular row with no tag on its title; its artist line carries the credit it has
    for (const x of [a, b, c]) expect(r.get(x.key)).toMatchObject({ canonicalKey: b.key, title: 'Latch', artist: 'Disclosure feat. Sam Smith' });
    // a title's "(feat. X)" moves to the artist line when the row is shown
    const only = byKey(buildCanonical([a])).get(a.key)!;
    expect(only).toMatchObject({ title: 'Latch', artist: 'Disclosure feat. Sam Smith', reason: 'cleaned' });
    // another lead artist is another song
    expect(byKey(buildCanonical([c, row('Sam Smith', 'Latch', 0.9)])).get(c.key)!.canonicalKey).toBe(c.key);
  });

  it('folds a pair one further credit apart, the case the release eval harness counts as a duplicate', () => {
    const solo = row('Calvin Harris', 'One Kiss', 0.8);
    const duo = row('Calvin Harris & Dua Lipa', 'One Kiss', 0.9);
    const r = byKey(buildCanonical([duo, solo]));
    expect(r.get(solo.key)!.canonicalKey).toBe(duo.key);
    expect(r.get(duo.key)).toMatchObject({ title: 'One Kiss', artist: 'Calvin Harris & Dua Lipa', reason: 'same' });
  });

  it('never folds or shows a song with little singing: the list hides those on the tag', () => {
    const song = row('A', 'Song', 0.5);
    const inst = row('A', 'Song (Instrumental)', 0.9);
    const karaoke = row('A', 'Song [Karaoke Version]', 0.9);
    const build = buildCanonical([song, inst, karaoke]);
    expect(build.groups).toEqual([]);
    expect(byKey(build).get(inst.key)).toMatchObject({ canonicalKey: inst.key, title: 'Song (Instrumental)', reason: 'same' });
    expect(byKey(build).get(karaoke.key)!.title).toBe('Song [Karaoke Version]');
  });

  it('records a cleaned title for a song that has no twin, and what the row had when it was worked out', () => {
    const a = row('Madonna', 'Material Girl (Album Version)');
    const b = row('Madonna', 'Like a Prayer');
    const r = byKey(buildCanonical([a, b]));
    expect(r.get(a.key)).toEqual({
      key: a.key, canonicalKey: a.key, title: 'Material Girl', artist: 'Madonna', method: CANONICAL_METHOD, reason: 'cleaned',
      sourceTitle: 'Material Girl (Album Version)', sourceArtist: 'Madonna',
    });
    expect(r.get(b.key)).toMatchObject({ reason: 'same', sourceTitle: 'Like a Prayer', sourceArtist: 'Madonna' });
  });

  it('gives a folded row the source it had, not the shown row’s', () => {
    const a = row('Aaliyah', "I Don't Wanna", 0.4);
    const b = row('Aaliyah', 'I Don’t Wanna', 0.6);
    expect(byKey(buildCanonical([a, b])).get(a.key)).toMatchObject({ sourceTitle: "I Don't Wanna", sourceArtist: 'Aaliyah', title: 'I Don’t Wanna' });
  });

  it('gives every row exactly one record, and every record names a row that points at itself', () => {
    const rows = [
      row('A', 'Song', 0.4), row('A', 'Song (Live)', 0.9), row('A', 'Song [DUET]', 0.1), row('B', 'Other', 0.3), row('B', 'Other.', 0.2),
      row('C', 'Song (Instrumental)', 0.5), row('D', '(Live)', 0.5), row('E', '???', 0.5), row('E', '???', 0.5),
    ];
    const { records } = buildCanonical(rows);
    expect(records.map((r) => r.key).sort()).toEqual(rows.map((r) => r.key).sort());
    const all = new Map(records.map((r) => [r.key, r]));
    for (const r of records) expect(all.get(r.canonicalKey)!.canonicalKey).toBe(r.canonicalKey);
  });

  it('gives the same records whatever order the rows come in', () => {
    const rows: CanonicalInput[] = [];
    for (let a = 0; a < 6; a++) {
      for (let k = 0; k < 10; k++) {
        const r = (x: number) => ((a * 31 + k * 17 + x * 13) % 100) / 100;
        rows.push(row(`Artist ${a}`, `Song ${k}`, r(1)));
        if (k % 2 === 0) rows.push(row(`Artist ${a}`, `Song ${k} (Live)`, r(2)));
        if (k % 3 === 0) rows.push(row(`Artist ${a}`, `Song ${k} [DUET]`, r(3)));
        if (k % 5 === 0) rows.push(row(`The Artist ${a}`, `Song ${k}!`, r(1), { low: 41 + (k % 10), high: 72 }));
        if (k % 4 === 1) rows.push(row(`Artist ${a}`, `Song ${k} `, r(2), { low: 53, high: 84, trust: ((a + k) % 3) as 0 | 1 | 2 }));
      }
    }
    const forward = buildCanonical(rows);
    expect(forward.groups.length).toBeGreaterThan(20);
    expect(forward.apart.length).toBeGreaterThan(0);
    expect(forward.groups.some((g) => g.octave)).toBe(true);
    for (const seed of [1, 2, 3]) expect(buildCanonical(shuffle(rows, seed))).toEqual(forward);
    expect(buildCanonical([...rows].reverse())).toEqual(forward);
  });
});

describe('buildCanonical: rows of one name whose ranges disagree stay two rows', () => {
  it('folds when both ends agree within MAX_RANGE_GAP, and not past it', () => {
    expect(MAX_RANGE_GAP).toBe(4);
    const a = row('A', 'Song', 0.6, { low: 41, high: 72 });
    const within = row('A', 'Song ', 0.5, { low: 45, high: 68 }); // 4 and 4 semitones away
    expect(byKey(buildCanonical([a, within])).get(within.key)!.canonicalKey).toBe(a.key);
    const past = row('A', 'Song  ', 0.5, { low: 41, high: 77 }); // the top is 5 away
    const build = buildCanonical([a, past]);
    expect(byKey(build).get(past.key)).toMatchObject({ canonicalKey: past.key, reason: 'same' });
    expect(byKey(build).get(a.key)!.canonicalKey).toBe(a.key);
    expect(build.groups).toEqual([]);
    expect(build.apart).toHaveLength(1);
    expect(build.apart[0]).toMatchObject({ gap: 5 });
    expect(build.apart[0]!.parts.map((p) => [p.low, p.high])).toEqual([[41, 72], [41, 77]]);
  });

  it('keeps an octave apart apart, the wrong-octave case, and still cleans both titles', () => {
    const high = row('Guns N’ Roses', 'Don’t Cry (Album Version)', 0.7, { low: 61, high: 83 });
    const low = row('Guns N’ Roses', "Don't Cry", 0.8, { low: 38, high: 60 });
    const build = buildCanonical([high, low]);
    expect(build.groups).toEqual([]);
    expect(byKey(build).get(high.key)).toMatchObject({ canonicalKey: high.key, title: 'Don’t Cry', reason: 'cleaned' });
    expect(byKey(build).get(low.key)).toMatchObject({ canonicalKey: low.key, reason: 'same' });
  });

  it('compares with the head of each part only, so a part cannot drift a few semitones at a time', () => {
    const a = row('A', 'Song', 0.9, { low: 40, high: 70 });
    const b = row('A', 'Song ', 0.8, { low: 43, high: 70 });
    const c = row('A', 'Song  ', 0.7, { low: 46, high: 70 }); // 3 from b, 6 from a
    const r = byKey(buildCanonical([a, b, c]));
    expect(r.get(b.key)!.canonicalKey).toBe(a.key);
    expect(r.get(c.key)!.canonicalKey).toBe(c.key);
  });

  it('still folds the rows of a part that agree, when another part does not', () => {
    const a = row('A', 'Song', 0.9, { low: 40, high: 70 });
    const a2 = row('A', 'Song (Album Version)', 0.8, { low: 41, high: 70 });
    const far = row('A', 'Song ', 0.7, { low: 52, high: 82 });
    const r = byKey(buildCanonical([far, a2, a]));
    expect(r.get(a2.key)!.canonicalKey).toBe(a.key);
    expect(r.get(far.key)!.canonicalKey).toBe(far.key);
  });
});

describe('buildCanonical: rows an octave apart', () => {
  it('folds a recording and a note file an octave apart into the recording, however popular the note file is', () => {
    // Plain White T's, Hey There Delilah, as measured: a recording at 52 to 62 and a note file at 64 to 74
    const recording = row("Plain White T's", 'Hey There Delilah', 0.5, { low: 52, high: 62, trust: 2 });
    const noteFile = row('Plain White T’s', 'Hey There Delilah', 0.9, { low: 64, high: 74, trust: 0 });
    const build = buildCanonical([noteFile, recording]);
    expect(build.apart).toEqual([]);
    expect(byKey(build).get(noteFile.key)).toMatchObject({ canonicalKey: recording.key, reason: 'folded' });
    expect(byKey(build).get(recording.key)).toMatchObject({ canonicalKey: recording.key });
    expect(build.groups[0]).toMatchObject({ canonicalKey: recording.key, octave: true });
    expect(build.groups[0]!.members.map((m) => [m.low, m.high, m.trust])).toEqual([[64, 74, 0], [52, 62, 2]]);
  });

  it('shows the note file corrected from evidence over the one as written', () => {
    // ABBA, Money Money Money: one spelling was corrected from its recording, the other still has the file's octave
    const corrected = row('ABBA', 'Money, Money, Money', 0.4, { low: 52, high: 65, trust: 1 });
    const written = row('ABBA', 'Money Money Money', 0.8, { low: 64, high: 77, trust: 0 });
    const build = buildCanonical([written, corrected]);
    expect(byKey(build).get(written.key)!.canonicalKey).toBe(corrected.key);
    expect(build.apart).toEqual([]);
    // and a recording beats a corrected note file
    const recording = row('ABBA', 'Money Money Money ', 0.1, { low: 52, high: 65, trust: 2 });
    expect(byKey(buildCanonical([written, corrected, recording])).get(corrected.key)!.canonicalKey).toBe(recording.key);
  });

  it('keeps two rows an octave apart when neither is better evidenced: there is nothing to say which is right', () => {
    for (const trust of [0, 1, 2] as const) {
      const a = row('A', 'Song', 0.5, { low: 40, high: 64, trust });
      const b = row('A', 'Song ', 0.4, { low: 52, high: 76, trust });
      const build = buildCanonical([a, b]);
      expect(build.groups).toEqual([]);
      expect(build.apart).toHaveLength(1);
      expect(byKey(build).get(b.key)!.canonicalKey).toBe(b.key);
    }
  });

  it('keeps rows apart that disagree by anything but an octave, evidence or not', () => {
    const base = row('A', 'Song', 0.5, { low: 40, high: 64, trust: 2 });
    for (const [low, high] of [[47, 71], [43, 67 + 6], [52, 64], [40, 76], [52, 70]] as const) {
      const other = row('A', 'Song ', 0.4, { low, high, trust: 0 });
      expect(buildCanonical([base, other]).groups).toEqual([]);
    }
  });

  it('allows OCTAVE_TOLERANCE semitones off the octave at each end, and not more', () => {
    expect(OCTAVE_TOLERANCE).toBe(2);
    const base = row('A', 'Song', 0.5, { low: 40, high: 64, trust: 2 });
    const within = row('A', 'Song ', 0.4, { low: 52 + 2, high: 76 - 2, trust: 0 });
    expect(byKey(buildCanonical([base, within])).get(within.key)!.canonicalKey).toBe(base.key);
    const past = row('A', 'Song  ', 0.4, { low: 52 + 3, high: 76, trust: 0 });
    expect(byKey(buildCanonical([base, past])).get(past.key)!.canonicalKey).toBe(past.key);
  });

  it('folds two octaves apart, either way round', () => {
    const base = row('A', 'Song', 0.5, { low: 52, high: 64, trust: 2 });
    for (const shift of [24, -24, -12]) {
      const other = row('A', 'Song ', 0.4, { low: 52 + shift, high: 64 + shift, trust: 0 });
      expect(byKey(buildCanonical([base, other])).get(other.key)!.canonicalKey).toBe(base.key);
    }
  });

  it('chooses among the best evidenced rows by the usual rules: a plain title first, then popularity', () => {
    const taggedRecording = row('A', 'Song (Live)', 0.35, { low: 52, high: 62, trust: 2 });
    const plainRecording = row('A', 'Song', 0.3, { low: 53, high: 62, trust: 2 });
    const noteFile = row('A', 'Song ', 0.95, { low: 64, high: 74, trust: 0 });
    const r = byKey(buildCanonical([noteFile, taggedRecording, plainRecording]));
    for (const x of [noteFile, taggedRecording, plainRecording]) expect(r.get(x.key)!.canonicalKey).toBe(plainRecording.key);
  });

  it('uses no evidence inside rows whose ranges agree: the plain title and popularity decide as before', () => {
    const recording = row('A', 'Song [DUET]', 0.55, { low: 41, high: 72, trust: 2 });
    const noteFile = row('A', 'Song', 0.5, { low: 43, high: 70, trust: 0 });
    const build = buildCanonical([recording, noteFile]);
    expect(byKey(build).get(recording.key)!.canonicalKey).toBe(noteFile.key);
    expect(build.groups[0]).toMatchObject({ octave: false });
  });

  it('still keeps a name apart that has both kinds of disagreement, and folds the rows that can be folded', () => {
    const a = row('A', 'Song', 0.9, { low: 40, high: 64, trust: 2 });
    const octave = row('A', 'Song ', 0.8, { low: 52, high: 76, trust: 0 });
    const fifth = row('A', 'Song  ', 0.7, { low: 47, high: 71, trust: 0 });
    const build = buildCanonical([a, octave, fifth]);
    const r = byKey(build);
    expect(r.get(octave.key)!.canonicalKey).toBe(a.key);
    expect(r.get(fifth.key)!.canonicalKey).toBe(fifth.key);
    expect(build.apart).toHaveLength(1);
  });
});

describe('applyCanonical: the list the app shows', () => {
  const rec = (key: string, canonicalKey: string, title: string, artist = 'Artist', reason: SongCanonical['reason'] = key === canonicalKey ? 'same' : 'folded'): SongCanonical => ({
    key, canonicalKey, title, artist, method: CANONICAL_METHOD, reason, sourceTitle: key.toUpperCase(), sourceArtist: 'Raw Artist',
  });
  const song = (key: string, title = key.toUpperCase(), artist = 'Raw Artist') => ({ key, title, artist });
  const mapping = (...rs: SongCanonical[]) => new Map(rs.map((r) => [r.key, r]));

  it('with no mapping the songs are exactly as they were, raw titles and all', () => {
    const songs = [song('a'), song('b')];
    expect(applyCanonical(songs, new Map())).toBe(songs);
  });

  it('drops a folded row when the row it folds into is in the list, and shows the clean title and artist', () => {
    const out = applyCanonical([song('b'), song('a'), song('c')], mapping(rec('a', 'a', 'Song', 'Aaliyah'), rec('b', 'a', 'Song', 'Aaliyah'), rec('c', 'c', 'Other')));
    expect(out).toEqual([
      { key: 'a', title: 'Song', artist: 'Aaliyah' },
      { key: 'c', title: 'Other', artist: 'Artist' },
    ]);
  });

  it('leaves a row the build has not seen exactly as it is', () => {
    const out = applyCanonical([song('a'), song('x', 'Raw (Album Version)')], mapping(rec('a', 'a', 'Clean')));
    expect(out).toEqual([{ key: 'a', title: 'Clean', artist: 'Artist' }, song('x', 'Raw (Album Version)')]);
  });

  it('ignores a record whose row has changed since: a stale clean title must not replace the live one', () => {
    // the build saw "Song"; a sync has since renamed the row "Song (Instrumental)", which the list hides on that tag
    const out = applyCanonical([{ key: 'a', title: 'Song (Instrumental)', artist: 'Raw Artist' }], mapping({ ...rec('a', 'a', 'Song'), sourceTitle: 'Song' }));
    expect(out).toEqual([{ key: 'a', title: 'Song (Instrumental)', artist: 'Raw Artist' }]);
    // the artist counts too
    const renamed = applyCanonical([{ key: 'a', title: 'A', artist: 'New Artist' }], mapping(rec('a', 'a', 'Clean')));
    expect(renamed).toEqual([{ key: 'a', title: 'A', artist: 'New Artist' }]);
  });

  it('shows a folded row on its own when its record is stale, so nothing is hidden on old information', () => {
    const out = applyCanonical(
      [song('a'), { key: 'b', title: 'Renamed', artist: 'Raw Artist' }],
      mapping(rec('a', 'a', 'Song'), rec('b', 'a', 'Song')), // b's record was made when b was called "B"
    );
    expect(out.map((s) => `${s.key}:${s.title}`)).toEqual(['a:Song', 'b:Renamed']);
  });

  it('drops a folded row into a loaded row that has no record of its own: the song shows once, as it is stored', () => {
    const out = applyCanonical([song('a'), song('b')], mapping(rec('b', 'a', 'Song')));
    expect(out).toEqual([song('a')]);
  });

  it('never loses a song to folding: when the row it folds into is not in the list, the first row of the song stays', () => {
    const m = mapping(rec('a', 'a', 'Song'), rec('b', 'a', 'Song'), rec('c', 'a', 'Song'));
    expect(applyCanonical([song('b'), song('c')], m).map((s) => s.key)).toEqual(['b']);
    expect(applyCanonical([song('c'), song('b')], m).map((s) => s.key)).toEqual(['c']);
    expect(applyCanonical([song('b')], m)).toEqual([{ key: 'b', title: 'Song', artist: 'Artist' }]);
  });

  it('drops nothing when the mapping contradicts itself, as a rebuild caught half written can', () => {
    // a says "shown as b", b says "shown as a": a duplicate for a moment beats a song missing for the cache's hour
    const out = applyCanonical([song('a'), song('b')], mapping(rec('a', 'b', 'Song', 'Artist', 'folded'), rec('b', 'a', 'Song', 'Artist', 'folded')));
    expect(out.map((s) => s.key).sort()).toEqual(['a', 'b']);
  });

  it('keeps the order of the list', () => {
    const out = applyCanonical([song('z'), song('y'), song('x'), song('w')], mapping(rec('y', 'y', 'Y'), rec('w', 'z', 'Z'), rec('z', 'z', 'Z')));
    expect(out.map((s) => s.key)).toEqual(['z', 'y', 'x']);
  });
});
