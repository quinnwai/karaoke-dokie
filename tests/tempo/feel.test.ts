import { describe, expect, it, vi } from 'vitest';
import { effectiveTempo, feelOfTempo, FEEL_BANDS, FEEL_REST, FEELS, isFeel, isWeakLabelSource, type Feel } from '../../src/lib/tempo/feel';
import { tempoOf } from '../../src/lib/tempo/tempo';

// The checked tempos are data that changes (data/tempo-gold.json), so these tests use their own.
vi.mock('../../src/lib/tempo/reviewed', () => {
  const checked = new Map([
    ['test|ballad in 12/8', 135], // counted in eighths: felt at half
    ['test|plain ballad', 74],
    ['test|very slow ballad', 62], // felt below 70: folding into 70 to 180 would double it to 124
    ['test|zero checked', 0], // not a tempo: counts as not checked
    ['test|very fast', 200],
  ]);
  return { reviewedBpm: (key: string) => checked.get(key) };
});

describe('feel bands', () => {
  it('touch, so every tempo is in exactly one', () => {
    expect(FEEL_BANDS.slow.max).toBe(FEEL_BANDS.mid.min);
    expect(FEEL_BANDS.mid.max).toBe(FEEL_BANDS.upbeat.min);
    expect([89.9, 90, 124.9, 125, 60, 180].map(feelOfTempo)).toEqual(['slow', 'mid', 'mid', 'upbeat', 'slow', 'upbeat']);
  });
  it('know the three labels and nothing else', () => {
    expect(FEELS).toEqual(['slow', 'mid', 'upbeat']);
    expect(isFeel('slow')).toBe(true);
    expect(isFeel('Slow')).toBe(false);
    expect(isFeel(undefined)).toBe(false);
  });
  it('rest inside their own band, at the edge facing the middle', () => {
    for (const f of FEELS) expect(feelOfTempo(FEEL_REST[f])).toBe(f);
    expect(FEEL_REST.slow).toBe(FEEL_BANDS.slow.max - 0.5);
    expect(FEEL_REST.upbeat).toBe(FEEL_BANDS.upbeat.min);
  });
});

describe('effectiveTempo without a label', () => {
  const { min, max } = FEEL_BANDS.mid;

  it('treats a published tempo like a measured one: it goes into the mid band too, ahead of what was measured', () => {
    // Published 74 beats Deezer's 148, and is squeezed the same way (74 -> 91.25). It is evidence, not a label: a published
    // tempo is a notated beat, which is not always the felt one (Piano Man is quarter = 168 in 3/4).
    const t = effectiveTempo({ key: 'test|plain ballad', record: { deezerBpm: 148 } })!;
    expect(t).toMatchObject({ source: 'reviewed', adjusted: 'compressed' });
    expect(t.tempo).toBeCloseTo(91.25, 2);
    expect(effectiveTempo({ key: 'test|plain ballad' })).toEqual(t);
  });

  it('clamps a published tempo to 70 to 180 before squeezing it, so a very slow or very fast one stays in the mid band', () => {
    expect(effectiveTempo({ key: 'test|very slow ballad', record: { deezerBpm: 124 } })).toEqual({ tempo: FEEL_BANDS.mid.min, source: 'reviewed', adjusted: 'compressed' });
    const fast = effectiveTempo({ key: 'test|very fast' })!;
    expect(fast.tempo).toBe(FEEL_BANDS.mid.max - 0.5);
    expect(feelOfTempo(fast.tempo)).toBe('mid');
  });

  it('squeezes a measured tempo into the mid band, so no song nobody vouched for reaches either end of the gear', () => {
    for (const bpm of [70, 74, 90, 100, 120, 147, 171, 179.9]) {
      const t = effectiveTempo({ record: { deezerBpm: bpm } })!;
      expect(t.tempo, `${bpm}`).toBeGreaterThanOrEqual(min);
      expect(t.tempo, `${bpm}`).toBeLessThan(max);
      expect(feelOfTempo(t.tempo)).toBe('mid');
      expect(t).toMatchObject({ source: 'deezer', adjusted: 'compressed' });
    }
    expect(effectiveTempo({ record: { deezerBpm: 70 } })!.tempo).toBe(min);
  });

  it('keeps the order of the measured tempos (and their ties), which is all a rank-placed gear reads', () => {
    const records = [{ deezerBpm: 70 }, { trackerBpm: 80.5 }, { deezerBpm: 100 }, { ultrastarBpm: 400 }, { deezerBpm: 100 }, { deezerBpm: 120 }, { deezerBpm: 147 }, { deezerBpm: 179 }];
    const measured = records.map((r) => tempoOf(r)!);
    const squeezed = records.map((r) => effectiveTempo({ record: r })!.tempo);
    for (let i = 0; i < records.length; i++) {
      for (let j = 0; j < records.length; j++) expect(Math.sign(squeezed[i]! - squeezed[j]!), `${i} vs ${j}`).toBe(Math.sign(measured[i]! - measured[j]!));
    }
  });

  it('counts a checked tempo that is not a number above zero as not checked', () => {
    expect(effectiveTempo({ key: 'test|zero checked', record: { deezerBpm: 120 } })).toEqual(effectiveTempo({ record: { deezerBpm: 120 } }));
    expect(effectiveTempo({ key: 'test|zero checked', record: { deezerBpm: 148 }, feel: 'slow' })).toEqual(effectiveTempo({ record: { deezerBpm: 148 }, feel: 'slow' }));
  });

  it('names the measured source, and is null when nothing was measured', () => {
    expect(effectiveTempo({ record: { trackerBpm: 99 } })?.source).toBe('tracker');
    expect(effectiveTempo({ record: { ultrastarBpm: 344 } })?.source).toBe('ultrastar');
    expect(effectiveTempo({ record: {} })).toBeNull();
    expect(effectiveTempo({ key: 'other|song' })).toBeNull();
    // a tracker reading nobody agrees with is left out first (QWW-54), so a song with only that has no tempo
    expect(effectiveTempo({ record: { trackerBpm: 172 } })).toBeNull();
  });
});

describe('effectiveTempo with a label', () => {
  it('keeps a reading that is already in the label\'s band, and says where it came from', () => {
    expect(effectiveTempo({ record: { deezerBpm: 74 }, feel: 'slow' })).toEqual({ tempo: 74, source: 'deezer' });
    expect(effectiveTempo({ record: { trackerBpm: 100 }, feel: 'mid' })).toEqual({ tempo: 100, source: 'tracker' });
    expect(effectiveTempo({ record: { ultrastarBpm: 600 }, feel: 'upbeat' })).toEqual({ tempo: 150, source: 'ultrastar' }); // grid / 4
  });

  it('halves a double-time reading of a slow song (the QWW-40 offenders)', () => {
    // Hey Jude on Deezer: 148 for a felt 74. The Beat tracker's 178 for Red Red Wine's felt 89.
    expect(effectiveTempo({ record: { deezerBpm: 148 }, feel: 'slow' })).toEqual({ tempo: 74, source: 'deezer', adjusted: 'halved' });
    expect(effectiveTempo({ record: { trackerBpm: 178 }, feel: 'slow' })).toEqual({ tempo: 89, source: 'tracker', adjusted: 'halved' });
    expect(effectiveTempo({ record: { deezerBpm: 170 }, feel: 'slow' })?.tempo).toBe(85);
  });

  it('prefers a reading that needs no change to a halved one, whatever the order: Deezer 148, tracker 74', () => {
    expect(effectiveTempo({ record: { deezerBpm: 148, trackerBpm: 74 }, feel: 'slow' })).toEqual({ tempo: 74, source: 'tracker' });
    expect(effectiveTempo({ record: { deezerBpm: 148, ultrastarBpm: 296 }, feel: 'slow' })).toEqual({ tempo: 74, source: 'ultrastar' });
  });

  // A value forced out of its band goes into a thin strip just inside the nearest edge (0.4 bpm wide).
  const inStrip = (bpm: number, edge: number) => {
    expect(bpm).toBeGreaterThanOrEqual(edge);
    expect(bpm).toBeLessThanOrEqual(edge + 0.4);
  };

  it('puts a song the label calls slow in the strip at the top of its band, not halved to a crawl, when the reading is close', () => {
    // 105 is only a little above the slow band; 52.5 would be a whole octave away from what was measured.
    const t = effectiveTempo({ record: { deezerBpm: 105 }, feel: 'slow' })!;
    expect(t).toMatchObject({ source: 'deezer', adjusted: 'clamped' });
    inStrip(t.tempo, FEEL_BANDS.slow.max - 0.5);
  });

  it('puts a song the label calls upbeat in the strip at the bottom of its band, not doubled above the songs that really are fast', () => {
    // A disco song counted at 101: upbeat by feel, and 202 would put it above Blinding Lights.
    const t = effectiveTempo({ record: { deezerBpm: 101 }, feel: 'upbeat' })!;
    expect(t).toMatchObject({ source: 'deezer', adjusted: 'clamped' });
    inStrip(t.tempo, FEEL_BANDS.upbeat.min);
    // A song read at half time: doubled into the band.
    expect(effectiveTempo({ record: { deezerBpm: 75 }, feel: 'upbeat' })).toEqual({ tempo: 150, source: 'deezer', adjusted: 'doubled' });
  });

  it('puts a mid song read slow or fast in the strip at the near edge of the mid band', () => {
    const slowRead = effectiveTempo({ record: { deezerBpm: 85 }, feel: 'mid' })!;
    expect(slowRead).toMatchObject({ source: 'deezer', adjusted: 'clamped' });
    inStrip(slowRead.tempo, FEEL_BANDS.mid.min);
    const fastRead = effectiveTempo({ record: { deezerBpm: 140 }, feel: 'mid' })!;
    expect(fastRead).toMatchObject({ source: 'deezer', adjusted: 'clamped' });
    inStrip(fastRead.tempo, FEEL_BANDS.mid.max - 0.5);
  });

  it('keeps songs forced to an edge in the order they were measured in, so the ones that fill an end are the nearest to it', () => {
    const at = (feel: Feel, bpm: number) => effectiveTempo({ record: { deezerBpm: bpm }, feel })!.tempo;
    // mid songs read slow: the slower the reading, the lower (nearer the slow end)
    expect(at('mid', 70)).toBeLessThan(at('mid', 80));
    expect(at('mid', 80)).toBeLessThan(at('mid', 88));
    // mid songs read fast: the faster the reading, the higher (nearer the upbeat end)
    expect(at('mid', 135)).toBeLessThan(at('mid', 150));
    // slow songs read above the band, and upbeat songs read below it: the nearer to the band, the nearer to its inside
    expect(at('slow', 95)).toBeLessThan(at('slow', 108));
    expect(at('upbeat', 100)).toBeLessThan(at('upbeat', 115));
    // and the strips never overlap a different band
    for (const f of FEELS) for (const bpm of [45, 60, 85, 100, 110, 130, 150, 200]) expect(feelOfTempo(at(f, bpm))).toBe(f);
  });

  it('holds a moved reading to the plausible tempos, but not a reading as written: no cliff just above 210', () => {
    // 212 is inside the upbeat band (to 215) and stays as written; 240 is out of it and goes to the strip at its top
    expect(effectiveTempo({ record: { deezerBpm: 212 }, feel: 'upbeat' })).toEqual({ tempo: 212, source: 'deezer' });
    const over = effectiveTempo({ record: { deezerBpm: 240 }, feel: 'upbeat' })!;
    expect(over).toMatchObject({ source: 'deezer', adjusted: 'clamped' });
    expect(over.tempo).toBeGreaterThan(214);
    // neighbours stay neighbours across 210
    const [a, b] = [210, 210.5].map((bpm) => effectiveTempo({ record: { deezerBpm: bpm }, feel: 'upbeat' })!.tempo);
    expect(Math.abs(a! - b!)).toBeLessThan(1);
    // a slow song read absurdly high is moved down into the slow band's neighbourhood, not stranded at the top of the gear
    expect(effectiveTempo({ record: { deezerBpm: 400 }, feel: 'slow' })!.tempo).toBeLessThan(90);
  });

  it('takes the earlier reading when two cost the same: Deezer before the tracker', () => {
    expect(effectiveTempo({ record: { deezerBpm: 74, trackerBpm: 74 }, feel: 'slow' })).toEqual({ tempo: 74, source: 'deezer' });
    expect(effectiveTempo({ record: { trackerBpm: 74, ultrastarBpm: 296 }, feel: 'slow' })).toEqual({ tempo: 74, source: 'tracker' });
  });

  it('uses a published tempo as written when a label puts it in its band: a very slow song stays very slow', () => {
    expect(effectiveTempo({ key: 'test|very slow ballad', record: { deezerBpm: 124 }, feel: 'slow' })).toEqual({ tempo: 62, source: 'reviewed' });
  });

  it('lets the label overrule a checked tempo counted in a different subdivision, and a checked tempo stand alone', () => {
    // 135 counted in eighths for a 12/8 ballad: the label brings it to the felt 67.5. The measured readings are not consulted.
    expect(effectiveTempo({ key: 'test|ballad in 12/8', record: { deezerBpm: 150, trackerBpm: 75 }, feel: 'slow' })).toEqual({ tempo: 67.5, source: 'reviewed', adjusted: 'halved' });
    expect(effectiveTempo({ key: 'test|plain ballad', record: { deezerBpm: 148 }, feel: 'slow' })).toEqual({ tempo: 74, source: 'reviewed' });
  });

  it('ranks a labelled song with no reading at its band\'s rest tempo, from the label alone', () => {
    expect(effectiveTempo({ feel: 'slow' })).toEqual({ tempo: FEEL_REST.slow, source: 'feel' });
    expect(effectiveTempo({ record: {}, feel: 'upbeat' })).toEqual({ tempo: FEEL_REST.upbeat, source: 'feel' });
    expect(effectiveTempo({ record: { deezerBpm: 0 }, feel: 'mid' })).toEqual({ tempo: FEEL_REST.mid, source: 'feel' });
  });

  it('never puts a song outside its label\'s band, whatever was measured', () => {
    const readings = [0.5, 1, 20, 33, 40, 55, 62, 70, 74, 89.9, 90, 100, 119, 125, 130, 148, 171, 180, 215, 260, 400, 1000];
    for (const feel of FEELS) {
      for (const bpm of readings) {
        for (const record of [{ deezerBpm: bpm }, { trackerBpm: bpm }, { ultrastarBpm: bpm * 4 }, { deezerBpm: bpm, trackerBpm: bpm * 2 }]) {
          const t = effectiveTempo({ record, feel })!;
          expect(feelOfTempo(t.tempo), `${feel} ${JSON.stringify(record)} -> ${t.tempo}`).toBe(feel);
        }
      }
    }
  });

  it('orders the songs of a band by how well the measurement agrees with the label: agreeing first at either end', () => {
    const at = (feel: Feel, bpm: number) => effectiveTempo({ record: { deezerBpm: bpm }, feel })!.tempo;
    // Slow: a true 62 first, then a 74, then one that was only close (105 clamped to the edge), so the slow end is the songs the numbers back up.
    expect(at('slow', 62)).toBeLessThan(at('slow', 74));
    expect(at('slow', 74)).toBeLessThan(at('slow', 105));
    // Upbeat: a true 172 above a 150, above a disco song at 101 that the label alone calls upbeat.
    expect(at('upbeat', 172)).toBeGreaterThan(at('upbeat', 150));
    expect(at('upbeat', 150)).toBeGreaterThan(at('upbeat', 101));
  });

  it('keeps every slow song below every mid song below every upbeat song', () => {
    const all = FEELS.flatMap((feel) => [40, 62, 85, 100, 118, 140, 171, 190].map((bpm) => ({ feel, t: effectiveTempo({ record: { deezerBpm: bpm }, feel })!.tempo })));
    for (const a of all) for (const b of all) if (FEELS.indexOf(a.feel) < FEELS.indexOf(b.feel)) expect(a.t).toBeLessThan(b.t);
  });
});

describe('weak labels: the second look and the band-edge audit rank behind the strict first pass', () => {
  const weak = (feel: Feel, bpm: number) => effectiveTempo({ record: { deezerBpm: bpm }, feel, weak: true })!;
  const clear = (feel: Feel, bpm: number) => effectiveTempo({ record: { deezerBpm: bpm }, feel })!;

  it('knows the plain-definition passes by their source, and nothing else', () => {
    expect(isWeakLabelSource('claude-opus-5-5/feel-plain-v1')).toBe(true);
    expect(isWeakLabelSource('claude-opus-5-5/feel-edge-recheck-v1')).toBe(true);
    // the strict first pass, the strict recheck (which only makes mids), a person's fix, anything unnamed
    for (const source of ['claude-opus-5-5/feel-v1', 'claude-opus-5-5/feel-recheck-v1', 'manual/hand-fix-qww-54b', 'test/v1', '', undefined]) {
      expect(isWeakLabelSource(source), String(source)).toBe(false);
    }
  });

  it('puts a weak slow song in the strip at the top of the slow band, behind a clear one, in the order of its own tempo', () => {
    for (const bpm of [45, 50, 70, 85]) expect(weak('slow', bpm).tempo).toBeGreaterThanOrEqual(89.5);
    for (const bpm of [45, 50, 70, 85]) expect(weak('slow', bpm).tempo).toBeLessThanOrEqual(89.9);
    for (const bpm of [45, 70, 85]) expect(clear('slow', 85).tempo).toBeLessThan(weak('slow', bpm).tempo); // a clear 85 is still ahead of the weak 45
    expect(weak('slow', 50).tempo).toBeLessThan(weak('slow', 70).tempo);
    expect(weak('slow', 70).tempo).toBeLessThan(weak('slow', 85).tempo);
    expect(weak('slow', 70)).toMatchObject({ weak: true, source: 'deezer' });
    expect(clear('slow', 70)).not.toHaveProperty('weak');
  });

  it('puts a weak upbeat song in the strip at the bottom of the upbeat band, behind a clear one, in the order of its own tempo', () => {
    for (const bpm of [130, 150, 180]) {
      expect(weak('upbeat', bpm).tempo).toBeGreaterThanOrEqual(125);
      expect(weak('upbeat', bpm).tempo).toBeLessThanOrEqual(125.4);
      expect(clear('upbeat', 150).tempo).toBeGreaterThan(weak('upbeat', bpm).tempo);
    }
    expect(weak('upbeat', 130).tempo).toBeLessThan(weak('upbeat', 170).tempo);
  });

  it('still halves or doubles the reading first, and says so', () => {
    // 148 on a slow label: halved to 74 (so it sits at 74/90 of the band), and then it goes to the strip because the label is weak
    expect(weak('slow', 148)).toMatchObject({ adjusted: 'halved', weak: true });
    expect(weak('slow', 148).tempo).toBeCloseTo(89.5 + 0.4 * ((74 - 40) / 50), 6);
    expect(weak('upbeat', 70)).toMatchObject({ adjusted: 'doubled', weak: true });
  });

  it('leaves a mid label and a song with no label as they are', () => {
    expect(weak('mid', 100)).toEqual(clear('mid', 100));
    expect(effectiveTempo({ record: { deezerBpm: 100 }, weak: true })).toEqual(effectiveTempo({ record: { deezerBpm: 100 } }));
    expect(effectiveTempo({ feel: 'mid', weak: true })).toEqual({ tempo: FEEL_REST.mid, source: 'feel' });
  });

  it('puts a weak label with no reading last in the strip, behind the weak songs whose readings back their label, not at rest', () => {
    // Only the label vouches for it, so it is the least backed of all: the inner end of the strip. (It used to rest at FEEL_REST,
    // which for slow is the front of the strip, ahead of every weak song with a reading.)
    const slow = effectiveTempo({ feel: 'slow', weak: true })!;
    const upbeat = effectiveTempo({ feel: 'upbeat', weak: true })!;
    expect(slow).toMatchObject({ source: 'feel', weak: true });
    expect(upbeat).toMatchObject({ source: 'feel', weak: true });
    expect(slow.tempo).toBeCloseTo(FEEL_BANDS.slow.max - 0.5 + 0.4, 9);
    expect(upbeat.tempo).toBe(FEEL_BANDS.upbeat.min);
    for (const bpm of [45, 50, 70, 85, 100, 148]) expect(weak('slow', bpm).tempo, `slow ${bpm}`).toBeLessThanOrEqual(slow.tempo);
    for (const bpm of [70, 130, 150, 190]) expect(weak('upbeat', bpm).tempo, `upbeat ${bpm}`).toBeGreaterThanOrEqual(upbeat.tempo);
    // A clear label with no reading is as it was: at rest, ahead of the weak one at the slow end.
    expect(effectiveTempo({ feel: 'slow' })).toEqual({ tempo: FEEL_REST.slow, source: 'feel' });
    expect(effectiveTempo({ feel: 'upbeat' })).toEqual({ tempo: FEEL_REST.upbeat, source: 'feel' });
    expect(effectiveTempo({ feel: 'slow' })!.tempo).toBeLessThan(slow.tempo);
    // And the same for a record with no usable number in it.
    expect(effectiveTempo({ record: { deezerBpm: 0 }, feel: 'slow', weak: true })).toEqual(slow);
  });

  it('never leaves the label\'s band, so a weak slow song is still below every mid song and a weak upbeat song above', () => {
    const all = FEELS.flatMap((feel) => [40, 62, 85, 100, 118, 140, 171, 190].flatMap((bpm) => [true, false].map((w) => ({ feel, t: weak(feel, bpm).tempo * Number(w) + clear(feel, bpm).tempo * Number(!w) }))));
    for (const a of all) for (const b of all) if (FEELS.indexOf(a.feel) < FEELS.indexOf(b.feel)) expect(a.t).toBeLessThan(b.t);
  });
});
