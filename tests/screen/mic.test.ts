// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserMic, classifyMicError, IDLE_KEEP, MicError, queryMicPermission, SampleBuffer } from '../../src/lib/client/mic';

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

  describe('while nobody is recording (the singer is between notes)', () => {
    const chunk = (n: number, v = 0.1) => new Float32Array(n).fill(v);

    it('keeps only the latest sound, so a microphone left open does not fill the phone', () => {
      const b = new SampleBuffer();
      for (let i = 0; i < 1000; i++) b.push(chunk(1024)); // about 23 s at 44.1 kHz
      expect(b.all().length).toBeGreaterThanOrEqual(IDLE_KEEP);
      expect(b.all().length).toBeLessThan(IDLE_KEEP + 1024);
      // What the live pitch reads once a hold begins is still there.
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
    // Android asks a second question of its own; a no to it is not something the page's settings can undo.
    expect(classifyMicError(err('NotAllowedError', 'Permission denied by system'))).toBe('system');
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

// browserMic.open() against a browser that is only pretended: the real one is a phone, and what a phone does with
// these calls is checked by hand. What is pinned here is what open() does for each thing a browser may do.
describe('browserMic.open', () => {
  type Behaviour = 'allow' | 'hold-back' | 'allow-after-capture';

  /** An AudioContext that starts, holds the audio back (resume() waits, as the spec says), or starts only once asked again. */
  function installAudio(behaviour: Behaviour, hooks: { source?: () => unknown } = {}) {
    const made: FakeCtx[] = [];
    class FakeCtx {
      state: 'suspended' | 'running' | 'closed' = behaviour === 'allow' ? 'running' : 'suspended';
      sampleRate = 48000;
      destination = {};
      resumeCalls = 0;
      closed = false;
      constructor() {
        made.push(this);
      }
      resume() {
        this.resumeCalls++;
        if (behaviour === 'allow') return Promise.resolve();
        // Held back: this promise settles only when the browser lets the audio start, which a tap does.
        if (behaviour === 'allow-after-capture' && this.resumeCalls >= 2) {
          this.state = 'running';
          return Promise.resolve();
        }
        return new Promise<void>(() => {});
      }
      close() {
        this.closed = true;
        this.state = 'closed';
        return Promise.resolve();
      }
      createMediaStreamSource() {
        return (hooks.source ?? (() => ({ connect() {}, disconnect() {} })))();
      }
      createGain() {
        return { gain: { value: 1 }, connect() {} };
      }
      createScriptProcessor() {
        return { connect() {}, disconnect() {}, onaudioprocess: null };
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: FakeCtx, configurable: true });
    return made;
  }

  function installMic(result: 'allow' | Error) {
    const track = { readyState: 'live' as 'live' | 'ended', stop: vi.fn(() => void (track.readyState = 'ended')) };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    const getUserMedia = vi.fn(async () => {
      if (result !== 'allow') throw result;
      return stream;
    });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    return { track, getUserMedia };
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).AudioContext;
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  });

  it('opens at once when the browser lets the audio start, and asks for audio with no filtering (a voice, not a call)', async () => {
    const [ctx] = [installAudio('allow')];
    const { getUserMedia } = installMic('allow');
    const rec = await browserMic.open();
    expect(rec.running()).toBe(true);
    expect(rec.live()).toBe(true);
    expect(rec.sampleRate).toBe(48000);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    expect(ctx).toHaveLength(1);
  });

  it('does not wait for audio the browser holds back: a microphone allowed earlier, opened with no tap, still opens', async () => {
    // The first resume() never settles (no tap yet), and open() has to finish anyway or the singer sees a blank screen.
    const made = installAudio('hold-back');
    installMic('allow');
    const rec = await Promise.race([browserMic.open(), new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 200))]);
    expect(rec).not.toBe('stuck');
    if (rec === 'stuck') return;
    // The microphone is on, the audio is not, and the recorder says so, so the screen can ask for a tap.
    expect(rec.live()).toBe(true);
    expect(rec.running()).toBe(false);
    expect(made[0]!.resumeCalls).toBe(2); // once at the start, once more now that the page is capturing
    // The tap starts it (a real browser settles resume() then).
    made[0]!.state = 'running';
    rec.resume();
    expect(made[0]!.resumeCalls).toBe(3);
    expect(rec.running()).toBe(true);
  });

  it('asks again once the page is capturing, which is when a browser lets the audio start without a tap', async () => {
    const made = installAudio('allow-after-capture');
    installMic('allow');
    const rec = await browserMic.open();
    expect(rec.running()).toBe(true);
    expect(made[0]!.resumeCalls).toBe(2);
  });

  it('turns every way the question can fail into a MicError with its reason, and lets go of the audio', async () => {
    for (const [name, message, reason] of [
      ['NotAllowedError', 'Permission denied', 'denied'],
      ['NotAllowedError', 'Permission dismissed', 'dismissed'],
      ['NotAllowedError', 'Permission denied by system', 'system'],
      ['NotFoundError', 'Requested device not found', 'missing'],
      ['NotReadableError', 'Could not start audio source', 'busy'],
      ['OverconstrainedError', 'x', 'unsupported'],
    ] as const) {
      const made = installAudio('allow');
      installMic(Object.assign(new Error(message), { name }));
      const failure = await browserMic.open().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(MicError);
      expect((failure as MicError).reason).toBe(reason);
      expect((failure as MicError).message).toBe(message);
      expect(made[0]!.closed).toBe(true);
    }
  });

  it('says "unsupported" where there is no microphone API at all (a page that is not secure, an old browser)', async () => {
    installAudio('allow');
    const failure = await browserMic.open().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MicError);
    expect((failure as MicError).reason).toBe('unsupported');
  });

  it('lets go of the microphone if anything after the question goes wrong: no red dot with no screen to turn it off', async () => {
    const made = installAudio('allow', {
      source: () => {
        throw new Error('cannot build the graph');
      },
    });
    const { track } = installMic('allow');
    const failure = await browserMic.open().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MicError);
    expect((failure as MicError).reason).toBe('unsupported');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(made[0]!.closed).toBe(true);
  });

  it('live() follows the microphone: false once the browser ends it, and close() lets everything go', async () => {
    const made = installAudio('allow');
    const { track } = installMic('allow');
    const rec = await browserMic.open();
    expect(rec.live()).toBe(true);
    track.readyState = 'ended';
    expect(rec.live()).toBe(false);
    track.readyState = 'live';
    rec.close();
    expect(track.stop).toHaveBeenCalled();
    expect(made[0]!.closed).toBe(true);
  });
});
