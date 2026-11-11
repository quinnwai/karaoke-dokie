import { describe, expect, it } from 'vitest';
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
