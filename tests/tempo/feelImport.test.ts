import { describe, expect, it } from 'vitest';
import { parseFeelFile } from '../../src/lib/tempo/feelFile';
import { planFeelImport, SCRATCH_DB, writeRefusal } from '../../src/lib/tempo/feelImport';
import type { SongFeelRecord } from '../../src/lib/tempo/feel';
import type { SongTempoRecord } from '../../src/lib/tempo/tempo';

describe('writeRefusal: where a write may go', () => {
  it('lets the scratch database take writes with no flags', () => {
    expect(SCRATCH_DB).toBe('karaoke_pr4_preview');
    expect(writeRefusal('karaoke_pr4_preview', {})).toBeNull();
  });

  it('refuses production unless both flags are given and the name matches the database it is really connected to', () => {
    for (const flags of [{}, { production: true }, { confirmDatabase: 'neondb' }, { production: true, confirmDatabase: 'other' }, { production: false, confirmDatabase: 'neondb' }]) {
      expect(writeRefusal('neondb', flags), JSON.stringify(flags)).toContain('Refusing to write to neondb');
    }
    expect(writeRefusal('neondb', { production: true, confirmDatabase: 'neondb' })).toBeNull();
  });

  it('does not take a lookalike for the scratch database', () => {
    for (const db of ['karaoke_pr4_preview_2', 'Karaoke_pr4_preview', 'karaoke_pr4', 'neondb', '']) expect(writeRefusal(db, {})).not.toBeNull();
  });
});

describe('planFeelImport: what the step would write and what it does to the Tempo gear', () => {
  const catalogue = [
    { key: 'a|upbeat song', artist: 'A', title: 'Upbeat Song' },
    { key: 'b|double time ballad', artist: 'B', title: 'Double Time Ballad' },
    { key: 'c|no tempo', artist: 'C', title: 'No Tempo' },
    { key: 'd|unlabelled', artist: 'D', title: 'Unlabelled' },
  ];
  const tempos = new Map<string, SongTempoRecord>([
    ['a|upbeat song', { key: 'a|upbeat song', deezerBpm: 172 }],
    ['b|double time ballad', { key: 'b|double time ballad', deezerBpm: 148 }],
    ['d|unlabelled', { key: 'd|unlabelled', deezerBpm: 100 }],
  ]);
  const file = parseFeelFile(
    JSON.stringify({
      method: 'test/v1',
      labeledAt: '2026-11-10',
      labels: [
        { keys: ['a|upbeat song'], feel: 'upbeat' },
        { keys: ['b|double time ballad'], feel: 'slow' },
        { keys: ['c|no tempo'], feel: 'mid' },
        { keys: ['not in|the catalogue'], feel: 'slow' },
      ],
    }),
  );

  it('writes a row for each labelled catalogue song and counts the rest', () => {
    const plan = planFeelImport({ catalogue, tempos, current: new Map(), file });
    expect(plan.rows.map((r) => r.key)).toEqual(['a|upbeat song', 'b|double time ballad', 'c|no tempo']);
    expect(plan.unmatched).toBe(1);
    expect(plan.toWrite).toHaveLength(3);
    expect(plan.added).toBe(3);
  });

  it('says what the labels do to the gear: one stays, one moves a band by halving, one gets its tempo from the label alone', () => {
    const { effect, moves } = planFeelImport({ catalogue, tempos, current: new Map(), file });
    expect(effect).toEqual({ sameBand: 1, moved: 1, noMeasured: 1, fromLabelAlone: 1, halved: 1, doubled: 0, clamped: 0 });
    expect(moves).toEqual(['    2. B - Double Time Ballad: 148 bpm (upbeat) -> 74 (slow)']);
  });

  it('writes only what is missing or different, so a rerun does the rest and a finished run does nothing', () => {
    const row = (key: string, feel: SongFeelRecord['feel'], source = 'test/v1'): SongFeelRecord => ({ key, feel, source, labeledAt: '2026-11-01' });
    // one row already there and equal (only its time differs), one there with another label, one missing
    const partly = planFeelImport({ catalogue, tempos, current: new Map([row('a|upbeat song', 'upbeat'), row('b|double time ballad', 'mid')].map((r) => [r.key, r])), file });
    expect(partly.toWrite.map((r) => `${r.key} ${r.feel}`)).toEqual(['b|double time ballad slow', 'c|no tempo mid']);
    expect(partly.added).toBe(1);
    // another method relabels
    const relabel = planFeelImport({ catalogue, tempos, current: new Map([['a|upbeat song', row('a|upbeat song', 'upbeat', 'older/v0')]]), file });
    expect(relabel.toWrite.map((r) => r.key)).toContain('a|upbeat song');
    // everything there already
    const done = planFeelImport({ catalogue, tempos, current: new Map(planFeelImport({ catalogue, tempos, current: new Map(), file }).rows.map((r) => [r.key, r])), file });
    expect(done.toWrite).toEqual([]);
    expect(done.added).toBe(0);
  });
});
