// @vitest-environment jsdom
// useRankedSetlist (src/lib/client/useRankedSetlist.ts): asks the ranking engine for the list that goes with what the
// singer has set, and keeps the answer. The engine here is a fake whose answers the test settles by hand, so the order in
// which answers arrive, and whether they arrive at all, is the test's to choose. A request that goes null (no range yet,
// or the songs are loading) shows nothing at all: the answer to an earlier range or sign-in must never stand in for it.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRankedSetlist, type RankedSetlist } from '../../src/lib/client/useRankedSetlist';
import type { SetlistEngine } from '../../src/lib/setlist/engine';
import type { SetlistRequest, SetlistResponse } from '../../src/lib/setlist/types';
import { rankedSong, response } from '../helpers/setlist';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An engine that answers nothing until the test says so: each `rank` call is recorded with the answer it waits on. */
function fakeEngine() {
  const calls: { request: SetlistRequest; answer: Deferred<SetlistResponse> }[] = [];
  const engine: SetlistEngine = {
    rank: vi.fn((request: SetlistRequest) => {
      const answer = deferred<SetlistResponse>();
      calls.push({ request, answer });
      return answer.promise;
    }),
  };
  /** The `n`th call the engine got (0 is the first). */
  const call = (n: number) => {
    const found = calls[n];
    if (!found) throw new Error(`The engine was asked ${calls.length} times, not ${n + 1}`);
    return found;
  };
  return { engine, calls, call };
}

/** A request; `difficulty` is what tells one from another. */
const ask = (difficulty = 20): SetlistRequest => ({
  range: { low: 45, high: 72 },
  gears: { difficulty, history: 70, popularity: 100, tempo: 50 },
  off: ['tempo', 'era'],
  eras: ['s90', 's00', 's10'],
});

/** A whole answer whose songs are told apart by their ids. */
const answer = (...songIds: string[]): SetlistResponse => response(songIds.map((id) => rankedSong(id)));

interface Props {
  engine: SetlistEngine;
  request: SetlistRequest | null;
}
/** The hook, with a log of what it returned on every render: a stale answer shown for one render would be in it. */
function setup(props: Props) {
  const renders: RankedSetlist[] = [];
  const view = renderHook(
    (p: Props) => {
      const value = useRankedSetlist(p.engine, p.request);
      renders.push(value);
      return value;
    },
    { initialProps: props },
  );
  return { ...view, renders };
}

/** A hook on a fresh fake engine, asked for `request` (a null request asks nothing). */
function started(request: SetlistRequest | null = ask(20)) {
  const fake = fakeEngine();
  return { ...fake, ...setup({ engine: fake.engine, request }) };
}

const NOTHING: RankedSetlist = { result: null, failed: false };
const ids = (state: RankedSetlist) => state.result?.songs.map((s) => s.match.track.id) ?? null;

/** Settles a call's answer inside act, so React has applied the update when the test looks. */
const answerWith = (c: { answer: Deferred<SetlistResponse> }, result: SetlistResponse) =>
  act(async () => {
    c.answer.resolve(result);
  });
const failWith = (c: { answer: Deferred<SetlistResponse> }) =>
  act(async () => {
    c.answer.reject(new Error('the engine is down'));
  });

describe('the first answer', () => {
  it('has no result and has not failed until the engine answers, then has the whole answer', async () => {
    const { engine, call } = fakeEngine();
    const { result } = setup({ engine, request: ask() });
    expect(result.current).toEqual(NOTHING);
    expect(engine.rank).toHaveBeenCalledTimes(1);

    const whole = response([rankedSong('a'), rankedSong('b')], { total: 40, nextOffset: 2, applied: ['difficulty'], libraryUnavailable: true });
    await answerWith(call(0), whole);
    // The answer is kept as it came, with its total, its next page and what counted, not only its songs.
    expect(result.current.result).toBe(whole);
    expect(result.current.result?.total).toBe(40);
    expect(result.current.result?.nextOffset).toBe(2);
    expect(result.current.result?.applied).toEqual(['difficulty']);
    expect(result.current.failed).toBe(false);
  });

  it('keeps the reason there are no songs, when the engine gives one', async () => {
    const { engine, call } = fakeEngine();
    const { result } = setup({ engine, request: ask() });
    await answerWith(call(0), response([], { empty: 'no-era-picked' }));
    expect(result.current.result?.songs).toEqual([]);
    expect(result.current.result?.empty).toBe('no-era-picked');
  });

  it('hands the engine the request it was given, as a copy of its own', () => {
    const { engine, call } = fakeEngine();
    const request = ask(35);
    setup({ engine, request });
    expect(call(0).request).toEqual(ask(35));
    // The engine may do what it likes with what it got: the caller's request is not shared with it.
    expect(call(0).request).not.toBe(request);
    call(0).request.gears.difficulty = 99;
    call(0).request.off.push('difficulty');
    expect(request).toEqual(ask(35));
  });

  it('asks nothing for a null request, and the state stays as it began', () => {
    const { engine } = fakeEngine();
    const { result, rerender } = setup({ engine, request: null });
    expect(engine.rank).not.toHaveBeenCalled();
    expect(result.current).toEqual(NOTHING);
    rerender({ engine, request: null });
    expect(engine.rank).not.toHaveBeenCalled();
    expect(result.current).toEqual(NOTHING);
  });

  it('asks as soon as the request is no longer null', async () => {
    const { engine, call } = fakeEngine();
    const { result, rerender } = setup({ engine, request: null });
    rerender({ engine, request: ask() });
    expect(engine.rank).toHaveBeenCalledTimes(1);
    await answerWith(call(0), answer('a'));
    expect(ids(result.current)).toEqual(['a']);
  });
});

describe('a new request', () => {
  it('keeps the last answer on screen until its own arrives', async () => {
    const { engine, call } = fakeEngine();
    const { result, rerender } = setup({ engine, request: ask(20) });
    const before = answer('a');
    await answerWith(call(0), before);

    rerender({ engine, request: ask(60) });
    expect(engine.rank).toHaveBeenCalledTimes(2);
    expect(call(1).request).toEqual(ask(60));
    expect(result.current.result).toBe(before);

    const after = answer('b');
    await answerWith(call(1), after);
    expect(result.current.result).toBe(after);
  });

  it('keeps the last answer in every render until its own arrives, the one that carries the new request included', async () => {
    const { engine, call } = fakeEngine();
    const { rerender, renders } = setup({ engine, request: ask(20) });
    const before = answer('a');
    await answerWith(call(0), before);

    const first = renders.length;
    rerender({ engine, request: ask(60) });
    expect(renders.length).toBeGreaterThan(first);
    for (const shown of renders.slice(first)) expect(shown.result).toBe(before);
  });

  it('is not a new question when it is a new object with the same values', () => {
    const { engine } = fakeEngine();
    const { rerender } = setup({ engine, request: ask(20) });
    rerender({ engine, request: ask(20) });
    rerender({ engine, request: ask(20) });
    expect(engine.rank).toHaveBeenCalledTimes(1);
  });

  it('is a new question for every change of a value, and each is asked once', () => {
    const { engine, calls } = fakeEngine();
    const { rerender } = setup({ engine, request: ask(20) });
    rerender({ engine, request: ask(21) });
    rerender({ engine, request: { ...ask(21), off: ['era'] } });
    rerender({ engine, request: { ...ask(21), off: ['era'], eras: ['s80'] } });
    expect(calls.map((c) => c.request)).toEqual([ask(20), ask(21), { ...ask(21), off: ['era'] }, { ...ask(21), off: ['era'], eras: ['s80'] }]);
  });

  it('is a new question for another page, which is part of the request', () => {
    const { engine, calls } = fakeEngine();
    const { rerender } = setup({ engine, request: ask(20) });
    rerender({ engine, request: { ...ask(20), offset: 100, limit: 50 } });
    expect(calls.map((c) => c.request)).toEqual([ask(20), { ...ask(20), offset: 100, limit: 50 }]);
  });
});

describe('a request that goes null (no range yet, or the songs are loading)', () => {
  /** A hook that has been answered once, and the log of its renders from that point on. */
  async function answered() {
    const view = started();
    const first = answer('a', 'b');
    await answerWith(view.call(0), first);
    expect(view.result.current.result).toBe(first);
    return { ...view, first, mark: view.renders.length };
  }

  it('shows nothing in the very render that carries it, before any effect has run to clear the old answer', async () => {
    const { engine, result, rerender, renders, mark } = await answered();
    rerender({ engine, request: null });
    // The first render after the change is the one that matters: a stale answer would show in it.
    const after = renders.slice(mark);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]).toEqual(NOTHING);
    for (const shown of after) expect(shown).toEqual(NOTHING);
    expect(result.current).toEqual(NOTHING);
  });

  it('stays empty while it is null, and asks the engine nothing', async () => {
    const { engine, result, rerender } = await answered();
    rerender({ engine, request: null });
    rerender({ engine, request: null });
    expect(engine.rank).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(NOTHING);
  });

  it('does not bring the earlier answer back when a request returns, not for one render', async () => {
    const { engine, call, result, rerender, renders } = await answered();
    rerender({ engine, request: null });
    const mark = renders.length;
    rerender({ engine, request: ask(60) });
    expect(engine.rank).toHaveBeenCalledTimes(2);
    expect(call(1).request).toEqual(ask(60));
    // Until its own answer arrives there is nothing, in every render.
    expect(renders.slice(mark).length).toBeGreaterThan(0);
    for (const shown of renders.slice(mark)) expect(shown).toEqual(NOTHING);
    expect(result.current).toEqual(NOTHING);

    const next = answer('c');
    await answerWith(call(1), next);
    expect(result.current.result).toBe(next);
  });

  it('asks again for the very request it asked before, and shows nothing of the old answer meanwhile', async () => {
    const { engine, call, result, rerender, renders } = await answered();
    rerender({ engine, request: null });
    const mark = renders.length;
    rerender({ engine, request: ask(20) });
    expect(engine.rank).toHaveBeenCalledTimes(2);
    expect(call(1).request).toEqual(ask(20));
    for (const shown of renders.slice(mark)) expect(shown).toEqual(NOTHING);
    expect(result.current).toEqual(NOTHING);
  });

  it('clears a failure too: a failed answer followed by a null request is nothing, not "failed"', async () => {
    const { engine, call, result, rerender } = started();
    await failWith(call(0));
    expect(result.current).toEqual({ result: null, failed: true });
    rerender({ engine, request: null });
    expect(result.current).toEqual(NOTHING);
    // And the failure does not come back with the next request.
    rerender({ engine, request: ask(60) });
    expect(result.current).toEqual(NOTHING);
  });

  it('clears a failure that kept the last songs, too', async () => {
    const { engine, call, result, rerender } = await answered();
    rerender({ engine, request: ask(60) });
    await failWith(call(1));
    expect(result.current.failed).toBe(true);
    expect(result.current.result).not.toBeNull();
    rerender({ engine, request: null });
    expect(result.current).toEqual(NOTHING);
  });

  it('drops an answer still in flight when it arrives after the request went null', async () => {
    const { engine, call, result, rerender, renders } = started();
    rerender({ engine, request: null });
    await answerWith(call(0), answer('late'));
    expect(result.current).toEqual(NOTHING);
    // Nothing was shown at any render, the late answer's included.
    for (const shown of renders) expect(shown).toEqual(NOTHING);
  });

  it('drops a failure still in flight when it arrives after the request went null', async () => {
    const { engine, call, result, rerender } = started();
    rerender({ engine, request: null });
    await failWith(call(0));
    expect(result.current).toEqual(NOTHING);
  });

  it('drops an answer in flight even when a request has come back since: it answers an older question', async () => {
    const { engine, call, result, rerender } = started();
    rerender({ engine, request: null });
    rerender({ engine, request: ask(60) });
    await answerWith(call(0), answer('late'));
    expect(result.current).toEqual(NOTHING);
    await answerWith(call(1), answer('current'));
    expect(ids(result.current)).toEqual(['current']);
  });
});

describe('an answer that arrives late', () => {
  it('is dropped when a newer request was sent after it: the slow answer never replaces the newer one', async () => {
    const { engine, call } = fakeEngine();
    const { result, rerender } = setup({ engine, request: ask(20) });
    rerender({ engine, request: ask(60) });

    // The first request's answer arrives after the second request was sent.
    await answerWith(call(0), answer('late'));
    expect(result.current).toEqual(NOTHING);

    await answerWith(call(1), answer('newer'));
    expect(ids(result.current)).toEqual(['newer']);
  });

  it('is dropped even when the newer request has already been answered', async () => {
    const { engine, call } = fakeEngine();
    const { result, rerender } = setup({ engine, request: ask(20) });
    rerender({ engine, request: ask(60) });

    await answerWith(call(1), answer('newer'));
    expect(ids(result.current)).toEqual(['newer']);
    await answerWith(call(0), answer('late'));
    expect(ids(result.current)).toEqual(['newer']);
  });

  it('does not make the screen fail when it is a failure of the older request', async () => {
    const { engine, call } = fakeEngine();
    const { result, rerender } = setup({ engine, request: ask(20) });
    rerender({ engine, request: ask(60) });
    await failWith(call(0));
    expect(result.current).toEqual(NOTHING);
    await answerWith(call(1), answer('newer'));
    expect(result.current.failed).toBe(false);
    expect(ids(result.current)).toEqual(['newer']);
  });

  it('is dropped when the engine itself changed in the meantime (its songs arrived), and the new engine is asked', async () => {
    const first = fakeEngine();
    const second = fakeEngine();
    const { result, rerender } = setup({ engine: first.engine, request: ask() });
    rerender({ engine: second.engine, request: ask() });
    expect(second.engine.rank).toHaveBeenCalledTimes(1);
    expect(second.call(0).request).toEqual(ask());

    await answerWith(first.call(0), answer('old'));
    expect(result.current.result).toBeNull();
    await answerWith(second.call(0), answer('new'));
    expect(ids(result.current)).toEqual(['new']);
  });

  it('is ignored once the screen is gone: nothing thrown, nothing warned', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = fakeEngine();
    const rejected = fakeEngine();
    const a = setup({ engine: resolved.engine, request: ask() });
    const b = setup({ engine: rejected.engine, request: ask() });
    a.unmount();
    b.unmount();
    await answerWith(resolved.call(0), answer('late'));
    await failWith(rejected.call(0));
    expect(error).not.toHaveBeenCalled();
  });
});

describe('an engine that fails', () => {
  it('sets failed and keeps the last answer, and the next answer clears failed', async () => {
    const { engine, call } = fakeEngine();
    const { result, rerender } = setup({ engine, request: ask(20) });
    const kept = answer('a');
    await answerWith(call(0), kept);

    rerender({ engine, request: ask(60) });
    await failWith(call(1));
    expect(result.current.failed).toBe(true);
    expect(result.current.result).toBe(kept);

    rerender({ engine, request: ask(80) });
    const fresh = answer('b');
    await answerWith(call(2), fresh);
    expect(result.current).toEqual({ result: fresh, failed: false });
  });

  it('has failed and no answer when it fails before it ever answered', async () => {
    const { engine, call } = fakeEngine();
    const { result } = setup({ engine, request: ask() });
    await failWith(call(0));
    expect(result.current).toEqual({ result: null, failed: true });
  });
});

describe('an engine that throws before it returns a promise (a bad song in its list)', () => {
  /**
   * An engine whose `rank` calls `behave`, which a test can change between requests: it returns a promise, or throws on the
   * spot like a ranking function that hits a malformed song before any asynchronous work has begun.
   */
  function throwing() {
    let behave: (request: SetlistRequest) => Promise<SetlistResponse> = () => {
      throw new Error('a song with no range');
    };
    const engine: SetlistEngine = { rank: vi.fn((request: SetlistRequest) => behave(request)) };
    return {
      engine,
      answerWith: (result: SetlistResponse) => (behave = () => Promise.resolve(result)),
      throwAgain: () =>
        (behave = () => {
          throw new Error('a song with no range');
        }),
      behave: (next: (request: SetlistRequest) => Promise<SetlistResponse>) => (behave = next),
    };
  }
  /** Lets the rejection the hook makes of a throw run its handlers, inside act. */
  const settle = () => act(async () => {});

  it('is a failed answer, not an error that takes the screen down: the hook still renders, with failed true and no answer', async () => {
    const { engine } = throwing();
    // renderHook would throw here if the effect let the error out.
    const { result, renders } = setup({ engine, request: ask() });
    await settle();
    expect(engine.rank).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ result: null, failed: true });
    // Never an answer, at any render.
    for (const shown of renders) expect(shown.result).toBeNull();
  });

  it('is asked once, and not again on the renders the failure causes', async () => {
    const { engine } = throwing();
    const { rerender } = setup({ engine, request: ask() });
    await settle();
    rerender({ engine, request: ask() });
    rerender({ engine, request: ask() });
    await settle();
    expect(engine.rank).toHaveBeenCalledTimes(1);
  });

  it('keeps the last answer when a later request makes it throw, and the next answer clears the failure', async () => {
    const fake = throwing();
    const kept = answer('a', 'b');
    fake.answerWith(kept);
    const { result, rerender, renders } = setup({ engine: fake.engine, request: ask(20) });
    await settle();
    expect(result.current).toEqual({ result: kept, failed: false });

    fake.throwAgain();
    rerender({ engine: fake.engine, request: ask(60) });
    await settle();
    expect(fake.engine.rank).toHaveBeenCalledTimes(2);
    expect(result.current.failed).toBe(true);
    expect(result.current.result).toBe(kept);
    expect(ids(result.current)).toEqual(['a', 'b']);
    // Once it had the answer, no render lost it, not even the ones the failing request caused.
    const firstWithIt = renders.findIndex((shown) => shown.result === kept);
    expect(firstWithIt).toBeGreaterThanOrEqual(0);
    for (const shown of renders.slice(firstWithIt)) expect(shown.result).toBe(kept);

    const fresh = answer('c');
    fake.answerWith(fresh);
    rerender({ engine: fake.engine, request: ask(80) });
    await settle();
    expect(result.current).toEqual({ result: fresh, failed: false });
  });

  it('is the failure of the newest request, which an older request\'s late answer does not undo', async () => {
    const fake = throwing();
    const older = deferred<SetlistResponse>();
    fake.behave(() => older.promise);
    const { result, rerender } = setup({ engine: fake.engine, request: ask(20) });
    fake.throwAgain();
    rerender({ engine: fake.engine, request: ask(60) });
    await settle();
    expect(result.current).toEqual({ result: null, failed: true });

    // The first request's answer arrives after the second one failed: it answers an older question, so it is dropped.
    await answerWith({ answer: older }, answer('late'));
    expect(result.current).toEqual({ result: null, failed: true });
  });

  it('goes with the request: a null request clears the failure, and the request after it is asked afresh', async () => {
    const fake = throwing();
    const { result, rerender } = setup({ engine: fake.engine, request: ask(20) });
    await settle();
    expect(result.current.failed).toBe(true);

    rerender({ engine: fake.engine, request: null });
    expect(result.current).toEqual(NOTHING);

    const fresh = answer('a');
    fake.answerWith(fresh);
    rerender({ engine: fake.engine, request: ask(20) });
    await settle();
    expect(fake.engine.rank).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ result: fresh, failed: false });
  });

  describe('debounce and abort', () => {
    it('asks at once the first time, then waits for the last of a burst of requests and aborts the one it replaced', async () => {
      vi.useFakeTimers();
      try {
        const { engine, calls } = fakeEngine();
        const signals: AbortSignal[] = [];
        vi.mocked(engine.rank).mockImplementation((request, signal) => {
          if (signal) signals.push(signal);
          const answer = deferred<SetlistResponse>();
          calls.push({ request, answer });
          return answer.promise;
        });
        const view = renderHook((p: Props & { wait: number }) => useRankedSetlist(p.engine, p.request, p.wait), { initialProps: { engine, request: ask(20), wait: 100 } });
        // The first question of a screen is not held back.
        expect(calls).toHaveLength(1);
        await act(async () => calls[0]!.answer.resolve(answer('a')));

        // A burst of requests, as a slider drag sends them: nothing is asked until it rests.
        view.rerender({ engine, request: ask(30), wait: 100 });
        view.rerender({ engine, request: ask(40), wait: 100 });
        view.rerender({ engine, request: ask(50), wait: 100 });
        expect(calls).toHaveLength(1);
        await act(async () => void vi.advanceTimersByTime(100));
        expect(calls).toHaveLength(2);
        expect(calls[1]!.request.gears.difficulty).toBe(50);

        // A newer request aborts the one still waiting for its answer.
        view.rerender({ engine, request: ask(60), wait: 100 });
        expect(signals[1]!.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
