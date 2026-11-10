// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyMicError, IDLE_KEEP, MicError, queryMicPermission, SampleBuffer } from '../../src/lib/client/mic';

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

  describe('while nobody is recording (the level meter is on, or the singer is between notes)', () => {
    const chunk = (n: number, v = 0.1) => new Float32Array(n).fill(v);

    it('keeps only the latest sound, so a microphone left open does not fill the phone', () => {
      const b = new SampleBuffer();
      for (let i = 0; i < 1000; i++) b.push(chunk(1024)); // about 23 s at 44.1 kHz
      expect(b.all().length).toBeGreaterThanOrEqual(IDLE_KEEP);
      expect(b.all().length).toBeLessThan(IDLE_KEEP + 1024);
      // What the meter and the live pitch read is still there.
      expect(b.latest(2048)).toHaveLength(2048);
    });

    it('keeps the latest samples, not the first', () => {
      const b = new SampleBuffer();
      for (let i = 0; i < 20; i++) b.push(chunk(1024, i));
      expect(b.latest(1)[0]).toBe(19);
      expect(b.all()[0]).toBeGreaterThan(0);
    });

    it('keeps everything from reset() to stop(), however long the hold, then goes back to keeping the latest', () => {
      const b = new SampleBuffer();
      for (let i = 0; i < 20; i++) b.push(chunk(1024));
      b.reset();
      for (let i = 0; i < 100; i++) b.push(chunk(1024));
      const held = b.stop();
      expect(held).toHaveLength(100 * 1024);
      expect(b.all().length).toBeLessThan(IDLE_KEEP + 1024);
      for (let i = 0; i < 100; i++) b.push(chunk(1024));
      expect(b.all().length).toBeLessThan(IDLE_KEEP + 1024);
    });

    it('a hold never loses its first sound to the trimming', () => {
      const b = new SampleBuffer();
      b.reset();
      b.push(chunk(1024, 0.5));
      for (let i = 0; i < 50; i++) b.push(chunk(1024, 0.1));
      expect(b.stop()[0]).toBeCloseTo(0.5);
    });
  });
});

describe('classifyMicError', () => {
  const err = (name: string, message = '') => Object.assign(new Error(message), { name });

  it('tells a refusal from a closed question, by what Chrome says', () => {
    expect(classifyMicError(err('NotAllowedError', 'Permission denied'))).toBe('denied');
    expect(classifyMicError(err('NotAllowedError', 'Permission dismissed'))).toBe('dismissed');
    expect(classifyMicError(err('NotAllowedError', 'The request is not allowed by the user agent or the platform in the current context.'))).toBe('denied');
    expect(classifyMicError(err('PermissionDeniedError'))).toBe('denied');
    expect(classifyMicError(err('SecurityError'))).toBe('denied');
  });

  it('knows a missing microphone and a busy one', () => {
    expect(classifyMicError(err('NotFoundError'))).toBe('missing');
    expect(classifyMicError(err('DevicesNotFoundError'))).toBe('missing');
    expect(classifyMicError(err('NotReadableError', 'Could not start audio source'))).toBe('busy');
    expect(classifyMicError(err('AbortError'))).toBe('busy');
    expect(classifyMicError(err('TrackStartError'))).toBe('busy');
  });

  it('calls anything else unsupported, whatever was thrown', () => {
    expect(classifyMicError(err('OverconstrainedError'))).toBe('unsupported');
    expect(classifyMicError(new TypeError('x'))).toBe('unsupported');
    expect(classifyMicError(null)).toBe('unsupported');
    expect(classifyMicError(undefined)).toBe('unsupported');
    expect(classifyMicError('nope')).toBe('unsupported');
  });

  it('MicError carries its reason', () => {
    const e = new MicError('busy');
    expect(e.reason).toBe('busy');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MicError');
    expect(new MicError('denied', 'no').message).toBe('no');
  });
});

describe('queryMicPermission', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'permissions');
  const setPermissions = (value: unknown) => Object.defineProperty(navigator, 'permissions', { value, configurable: true });

  afterEach(() => {
    vi.useRealTimers();
    if (original) Object.defineProperty(navigator, 'permissions', original);
    else delete (navigator as unknown as Record<string, unknown>).permissions;
  });

  it('reports what the browser says, asking for the microphone and nothing else', async () => {
    for (const state of ['granted', 'denied', 'prompt'] as const) {
      const query = vi.fn(async () => ({ state }));
      setPermissions({ query });
      expect(await queryMicPermission()).toBe(state);
      expect(query).toHaveBeenCalledWith({ name: 'microphone' });
    }
  });

  it('says unknown where the browser has no Permissions API', async () => {
    setPermissions(undefined);
    expect(await queryMicPermission()).toBe('unknown');
  });

  it('says unknown where the browser does not know the name "microphone" (Safari before 16 throws)', async () => {
    setPermissions({ query: vi.fn(async () => Promise.reject(new TypeError("Invalid value for 'name'"))) });
    expect(await queryMicPermission()).toBe('unknown');
    setPermissions({
      query: () => {
        throw new TypeError('not a function call that returns a promise');
      },
    });
    expect(await queryMicPermission()).toBe('unknown');
  });

  it('does not wait for ever on a browser that never answers', async () => {
    vi.useFakeTimers();
    setPermissions({ query: () => new Promise(() => {}) });
    const answer = queryMicPermission();
    await vi.advanceTimersByTimeAsync(500);
    expect(await answer).toBe('unknown');
    // And it leaves no timer behind.
    expect(vi.getTimerCount()).toBe(0);
  });
});
