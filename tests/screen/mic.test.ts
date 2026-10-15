// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SampleBuffer } from '../../src/lib/client/mic';

describe('SampleBuffer', () => {
  const buf = () => {
    const b = new SampleBuffer();
    b.push(Float32Array.from([1, 2, 3]));
    b.push(Float32Array.from([4, 5]));
    b.push(Float32Array.from([6, 7, 8, 9]));
    return b;
  };

  it('returns the latest n samples across chunks', () => {
    expect(Array.from(buf().latest(5))).toEqual([5, 6, 7, 8, 9]);
    expect(Array.from(buf().latest(7))).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it('returns what it has when asked for more', () => {
    expect(Array.from(buf().latest(100))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(buf().all())).toHaveLength(9);
  });

  it('reset starts a new recording', () => {
    const b = buf();
    b.reset();
    expect(b.all()).toHaveLength(0);
    b.push(Float32Array.from([1]));
    expect(Array.from(b.all())).toEqual([1]);
  });
});
