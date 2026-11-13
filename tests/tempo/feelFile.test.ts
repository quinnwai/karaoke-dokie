import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWeakLabelSource } from '../../src/lib/tempo/feel';
import { feelRows, parseFeelFile } from '../../src/lib/tempo/feelFile';

const file = (labels: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ method: 'test/v1', labeledAt: '2026-11-10', labels, ...extra });

describe('parseFeelFile', () => {
  it('reads a good file', () => {
    const f = parseFeelFile(file([{ keys: ['a|b', 'a & c|b'], feel: 'slow' }, { keys: ['d|e'], feel: 'upbeat' }]));
    expect(f.method).toBe('test/v1');
    expect(f.labels).toHaveLength(2);
  });

  it('refuses a file that is wrong anywhere, naming the label, so nothing half-good is written', () => {
    expect(() => parseFeelFile('{')).toThrow('not valid JSON');
    expect(() => parseFeelFile('null')).toThrow('expected an object');
    expect(() => parseFeelFile(file([], { method: '' }))).toThrow('"method"');
    expect(() => parseFeelFile(file([], { labeledAt: 'sometime' }))).toThrow('"labeledAt"');
    expect(() => parseFeelFile(JSON.stringify({ method: 'm', labeledAt: '2026-11-10' }))).toThrow('"labels"');
    expect(() => parseFeelFile(file([{ keys: ['a|b'], feel: 'slow' }, { keys: [], feel: 'slow' }]))).toThrow('label 2: "keys"');
    expect(() => parseFeelFile(file([{ keys: ['no pipe'], feel: 'slow' }]))).toThrow('label 1: "keys"');
    expect(() => parseFeelFile(file([{ keys: ['a|b'], feel: 'fast' }]))).toThrow('label 1: "feel"');
    expect(() => parseFeelFile(file([{ keys: ['a|b'], feel: 'slow', method: '' }]))).toThrow('label 1: "method"');
  });

  it('refuses a key labelled two ways, and allows the same label twice', () => {
    expect(() => parseFeelFile(file([{ keys: ['a|b'], feel: 'slow' }, { keys: ['x|y', 'a|b'], feel: 'upbeat' }]))).toThrow('a|b is labelled both slow and upbeat');
    expect(() => parseFeelFile(file([{ keys: ['a|b'], feel: 'slow' }, { keys: ['a|b'], feel: 'slow' }]))).not.toThrow();
  });
});

describe('feelRows', () => {
  const f = parseFeelFile(file([{ keys: ['mariah carey & boyz ii men|one sweet day', 'mariah carey|one sweet day'], feel: 'slow' }, { keys: ['nobody|else'], feel: 'mid' }, { keys: ['a|b'], feel: 'upbeat' }, { keys: ['a|b'], feel: 'upbeat' }]));

  it('makes a row for each key of the catalogue and counts the labels nothing in the catalogue matches', () => {
    const { rows, unmatched } = feelRows(f, new Set(['mariah carey|one sweet day', 'a|b', 'unlabelled|song']));
    expect(rows).toEqual([
      { key: 'mariah carey|one sweet day', feel: 'slow', source: 'test/v1', labeledAt: '2026-11-10' },
      { key: 'a|b', feel: 'upbeat', source: 'test/v1', labeledAt: '2026-11-10' },
    ]);
    expect(unmatched).toBe(1); // nobody|else
  });

  it('gives a row the method of its own label when it has one, the file\'s otherwise', () => {
    const f2 = parseFeelFile(file([{ keys: ['a|b'], feel: 'slow', method: 'second-look/v1' }, { keys: ['c|d'], feel: 'mid' }]));
    expect(feelRows(f2, new Set(['a|b', 'c|d'])).rows.map((r) => `${r.key} ${r.source}`)).toEqual(['a|b second-look/v1', 'c|d test/v1']);
  });

  it('writes a row for every key of a label the catalogue knows under more than one', () => {
    const { rows } = feelRows(f, new Set(['mariah carey & boyz ii men|one sweet day', 'mariah carey|one sweet day']));
    expect(rows.map((r) => r.key)).toEqual(['mariah carey & boyz ii men|one sweet day', 'mariah carey|one sweet day']);
  });
});

describe('data/tempo-feel.json: every method is classed as strict or weak on purpose (QWW-54)', () => {
  // isWeakLabelSource knows the plain-definition passes by name and counts every other source as strict, so a typo in a method, or a
  // new pass nobody classed, would silently rank as a clear label. Each method the file uses has to be in one of these two lists; a new
  // one fails here until somebody decides which it is (and adds it to WEAK_LABEL_SOURCE in src/lib/tempo/feel.ts if it is weak).
  const STRICT = [
    'claude-opus-5-5/feel-v1', // the strict first pass
    'claude-opus-5-5/feel-recheck-v1', // the strict recheck, which only takes labels away
    'manual/hand-fix-qww-54', // a person's fix: Take On Me
    'manual/hand-fix-qww-54b', // I See Fire
    'manual/hand-fix-qww-54d', // the 12 Nov fixes after the review; a hand-set label counts as clear
    'manual/hand-check-qww54-1', // Quinn-Wai's hand check of the lists (13 Nov): his 25 songs, set to mid by hand; counts as clear
    'claude-opus-5-5/feel-pace-recheck-v1', // the pace recheck (13 Nov): three blind runs on felt pace with his 25 as examples, a label moved only when two agreed, and only ever from upbeat to mid
  ];
  const WEAK = [
    'claude-opus-5-5/feel-plain-v1', // the second look, plain definitions
    'claude-opus-5-5/feel-edge-recheck-v1', // the band-edge audit, plain definitions
  ];
  const labels = parseFeelFile(readFileSync(join(__dirname, '../../data/tempo-feel.json'), 'utf8'));
  const used = new Set([labels.method, ...labels.labels.map((l) => l.method ?? labels.method)]);

  it('names every method the file uses', () => {
    expect([...used].filter((m) => !STRICT.includes(m) && !WEAK.includes(m)).sort(), 'methods nobody has classed').toEqual([]);
  });

  it('agrees with isWeakLabelSource about each of them, so the lists above are what the ranking does', () => {
    for (const m of STRICT) expect(isWeakLabelSource(m), `${m} is strict`).toBe(false);
    for (const m of WEAK) expect(isWeakLabelSource(m), `${m} is weak`).toBe(true);
    expect(STRICT.filter((m) => WEAK.includes(m))).toEqual([]);
  });

  it('has both kinds in it, so the check above is not about an empty list', () => {
    expect([...used].some((m) => WEAK.includes(m))).toBe(true);
    expect([...used].some((m) => STRICT.includes(m))).toBe(true);
  });
});

describe('data/tempo-feel.json: one label per song across its spellings (QWW-54, 13 Nov)', () => {
  // The catalogue knows a song under more than one key (an apostrophe, a credit, a hyphen), and a label that differs between them would
  // surface the day the other key becomes the song's row. These songs had two labels; each now has one under every key. Day 'n' Nite and
  // Summertime Sadness are not here on purpose: their "vs." credits are the remixes, other recordings with their own labels.
  const SPELLINGS: [string, string[]][] = [
    ['NSYNC, Bye Bye Bye', ['★n sync|bye bye bye', 'nsync|bye bye bye']],
    ["NSYNC, It's Gonna Be Me", ['★n sync|it’s gonna be me', "nsync|it's gonna be me"]],
    ['NSYNC, I Want You Back', ['★n sync|i want you back', 'nsync|i want you back', '*nsync|i want you back']],
    ['Zedd, Clarity', ['zedd & foxes|clarity', 'zedd|clarity']],
    ["James Arthur, Say You Won't Let Go", ["james arthur|say you won't let go", 'james arthur|say you won’t let go']],
    ["The Who, Won't Get Fooled Again", ["the who|won't get fooled again", 'the who|won’t get fooled again']],
    ['KT Tunstall, Black Horse and the Cherry Tree', ['kt tunstall|black horse & the cherry tree', 'kt tunstall|black horse and the cherry tree']],
    ['Ne-Yo, Let Me Love You', ['ne‐yo|let me love you', 'ne-yo|let me love you']],
    ['Kendrick Lamar, DNA.', ['kendrick lamar|dna', 'kendrick lamar|dna.']],
    ["En Vogue, My Lovin'", ['en vogue|my lovin’', "en vogue|my lovin'"]],
    ["Imagine Dragons, It's Time", ['imagine dragons|it’s time', "imagine dragons|it's time"]],
  ];
  const labels = parseFeelFile(readFileSync(join(__dirname, '../../data/tempo-feel.json'), 'utf8'));
  const feelOf = new Map(labels.labels.flatMap((l) => l.keys.map((k) => [k, l.feel] as const)));

  it.each(SPELLINGS)('%s has the same label under every spelling', (_song, keys) => {
    for (const k of keys) expect(feelOf.has(k), `${k} is in the file`).toBe(true);
    expect(new Set(keys.map((k) => feelOf.get(k))).size, keys.map((k) => `${k}: ${feelOf.get(k)}`).join('; ')).toBe(1);
  });
});
