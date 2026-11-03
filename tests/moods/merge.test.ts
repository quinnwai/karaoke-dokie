import { describe, expect, it } from 'vitest';
import type { Mood } from '../../src/lib/contracts';
import { addBatch, formatLabelRun, newLabelRun } from '../../src/lib/moods/label';
import { formatMoodRows, mergeMoodRows, readLabelsFile, sourceRank } from '../../src/lib/moods/merge';
import type { SongMoodsRecord } from '../../src/lib/server/store';

const row = (key: string, source: string, moods: Mood[] = [], method = `${source}-v1`): SongMoodsRecord => ({ key, moods, method, source });

describe('sourceRank', () => {
  it('trusts MGPHot, then AcousticBrainz, then any LLM, then anything else', () => {
    expect(sourceRank('mgphot')).toBeGreaterThan(sourceRank('acousticbrainz'));
    expect(sourceRank('acousticbrainz')).toBeGreaterThan(sourceRank('openai'));
    expect(['openai', 'gemini', 'claude'].map(sourceRank)).toEqual([1, 1, 1]);
    expect(sourceRank('somebody')).toBeLessThan(sourceRank('claude'));
  });
});

describe('mergeMoodRows', () => {
  it('never overwrites a row from a more trusted source in the store', () => {
    const current = new Map([['a|1', row('a|1', 'mgphot', ['heartfelt'])], ['a|2', row('a|2', 'acousticbrainz', ['upbeat'])]]);
    const out = mergeMoodRows(current, [row('a|1', 'acousticbrainz', ['upbeat']), row('a|1', 'openai', ['upbeat']), row('a|2', 'gemini', ['heartfelt'])]);
    expect(out).toEqual([]);
  });

  it('replaces a less trusted row, and an equal one (a relabel or a newer method)', () => {
    const current = new Map([
      ['a|1', row('a|1', 'openai', ['upbeat'])],
      ['a|2', row('a|2', 'openai', ['upbeat'], 'gpt-6-luna/moods-v1')],
      ['a|3', row('a|3', 'acousticbrainz', [], 'acousticbrainz-proxy-v1')],
      ['a|4', row('a|4', 'somebody', ['upbeat'])],
    ]);
    const out = mergeMoodRows(current, [
      row('a|1', 'acousticbrainz', []),
      row('a|2', 'openai', ['heartfelt'], 'gpt-6-luna/moods-v2'),
      row('a|3', 'mgphot', ['heartfelt']),
      row('a|4', 'claude', []),
      row('a|5', 'gemini', ['upbeat']),
    ]);
    expect(out).toEqual([
      row('a|1', 'acousticbrainz', []),
      row('a|2', 'openai', ['heartfelt'], 'gpt-6-luna/moods-v2'),
      row('a|3', 'mgphot', ['heartfelt']),
      row('a|4', 'claude', []),
      row('a|5', 'gemini', ['upbeat']),
    ]);
  });

  it('between incoming rows the more trusted wins whatever the order, and the later of equals', () => {
    const out = mergeMoodRows(new Map(), [
      row('a|1', 'openai', ['upbeat']),
      row('a|1', 'acousticbrainz', ['heartfelt']),
      row('a|1', 'gemini', ['upbeat']),
      row('a|2', 'openai', ['upbeat']),
      row('a|2', 'gemini', ['heartfelt']),
    ]);
    expect(out).toEqual([row('a|1', 'acousticbrainz', ['heartfelt']), row('a|2', 'gemini', ['heartfelt'])]);
  });

  it('a trusted source saying "no mood" still wins over an LLM saying yes', () => {
    expect(mergeMoodRows(new Map([['a|1', row('a|1', 'openai', ['upbeat'])]]), [row('a|1', 'acousticbrainz', [])])).toEqual([row('a|1', 'acousticbrainz', [])]);
  });
});

describe('label files', () => {
  it("round-trips a source's rows, keys and moods only, one song per line", () => {
    const rows = [row('a|1', 'acousticbrainz', ['upbeat', 'heartfelt'], 'acousticbrainz-proxy-v1'), row('a|2', 'acousticbrainz', [], 'acousticbrainz-proxy-v1')];
    const text = formatMoodRows({ comment: 'Made-up rows.', source: 'acousticbrainz', method: 'acousticbrainz-proxy-v1' }, rows);
    expect(text).toContain('\n    {"key":"a|1","moods":["upbeat","heartfelt"]},\n    {"key":"a|2","moods":[]}\n');
    expect(JSON.parse(text)).toMatchObject({ _comment: 'Made-up rows.', source: 'acousticbrainz', method: 'acousticbrainz-proxy-v1' });
    expect(readLabelsFile(text)).toEqual(rows);
    expect(() => formatMoodRows({ comment: '', source: 'acousticbrainz', method: 'v2' }, rows)).toThrow('only acousticbrainz rows made with v2');
  });

  it("reads a moods:label run as the rows of the songs the model knew, under its provider's source", () => {
    let run = newLabelRun('gpt-6-luna', 'openai');
    run = addBatch(run, {
      labels: [
        { key: 'a|1', known: true, upbeat: true, heartfelt: false },
        { key: 'a|2', known: false, upbeat: false, heartfelt: false },
      ],
      dropped: 0,
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'end_turn',
    });
    expect(readLabelsFile(formatLabelRun(run))).toEqual([{ key: 'a|1', moods: ['upbeat'], method: 'gpt-6-luna/moods-v1', source: 'openai' }]);
  });

  it('refuses anything else', () => {
    expect(() => readLabelsFile('[]')).toThrow('Not a labels file');
    expect(() => readLabelsFile(JSON.stringify({ source: 'x', method: 'y', songs: [{ key: 'a|1', moods: ['sad'] }] }))).toThrow('Not a labels file');
  });
});
