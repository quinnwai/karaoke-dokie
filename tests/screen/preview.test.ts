// The shared preview player behind every row's play button (QWW-48).
import { describe, expect, it, vi } from 'vitest';
import { createPreviewPlayer, previewSrc, RELOAD_AFTER_PAUSE_MS, type PreviewCheck } from '../../src/lib/client/preview';
import { FakeAudio, settle } from '../helpers/fakeAudio';

function setup(check: PreviewCheck = async () => 'retry') {
  const audio = new FakeAudio();
  let made = 0;
  let clock = 1_000_000;
  const checks = vi.fn(check);
  const player = createPreviewPlayer({
    makeAudio: () => {
      made++;
      return audio as unknown as HTMLAudioElement;
    },
    check: checks,
    now: () => clock,
  });
  const state = () => {
    const s = player.snapshot();
    return { key: s.key, status: s.status };
  };
  /** A tap on row t<n>, whose Deezer track is n (unless given). */
  const tap = (n: number, deezerId = n) => player.toggle(`t${n}`, deezerId);
  const wait = (ms: number) => {
    clock += ms;
  };
  return { audio, player, state, tap, checks, wait, made: () => made };
}

describe('preview player', () => {
  it('sets the address and calls play() inside the tap itself, as iOS needs, with no element until the first tap', () => {
    const { audio, state, tap, made } = setup();
    expect(made()).toBe(0);
    tap(3135556);
    // Both happened before toggle returned: nothing waited on a promise or a timer.
    expect(audio.log).toEqual([`src:${previewSrc(3135556)}`, 'play']);
    expect(previewSrc(3135556)).toBe('/api/preview/3135556');
    expect(state()).toEqual({ key: 't3135556', status: 'loading' });
    expect(made()).toBe(1);
  });

  it('shows playing once the sound starts, pauses on a second tap and resumes on a third, where it stopped', async () => {
    const { audio, player, state, tap } = setup();
    tap(1);
    audio.start();
    await settle();
    expect(state()).toEqual({ key: 't1', status: 'playing' });

    audio.currentTime = 12;
    tap(1);
    expect(state()).toEqual({ key: 't1', status: 'paused' });
    expect(player.progress()).toBeCloseTo(0.4);
    await settle();
    expect(state()).toEqual({ key: 't1', status: 'paused' });

    tap(1);
    expect(audio.srcs).toHaveLength(1); // the same load: it resumes, it does not start over
    expect(state()).toEqual({ key: 't1', status: 'loading' });
    audio.start();
    await settle();
    expect(state()).toEqual({ key: 't1', status: 'playing' });
    expect(audio.currentTime).toBe(12);
  });

  it('switches at once to another row, one song at a time', async () => {
    const { audio, state, tap } = setup();
    tap(1);
    audio.start();
    await settle();
    tap(2);
    expect(audio.src).toBe('/api/preview/2');
    expect(state()).toEqual({ key: 't2', status: 'loading' });
    audio.start();
    await settle();
    expect(state()).toEqual({ key: 't2', status: 'playing' });
  });

  it('five taps in five seconds end with the last-tapped song playing', async () => {
    const { audio, player, state, tap, checks } = setup();
    for (const [i, n] of [11, 22, 33, 44, 55].entries()) {
      tap(n);
      // The first two get far enough to make a sound; each newer tap cuts the older load short (AbortError).
      if (i < 2) audio.start();
      await settle();
    }
    expect(state()).toEqual({ key: 't55', status: 'loading' });
    audio.start();
    await settle();
    expect(state()).toEqual({ key: 't55', status: 'playing' });
    expect(audio.src).toBe('/api/preview/55');
    expect(player.snapshot().missing.size).toBe(0);
    expect(checks).not.toHaveBeenCalled();
  });

  it('a pause tapped before the sound starts stays paused', async () => {
    const { audio, state, tap } = setup();
    tap(1);
    tap(1);
    await settle();
    expect(state()).toEqual({ key: 't1', status: 'paused' });
    expect(audio.paused).toBe(true);
  });

  it('a song Deezer has no preview for goes back to play at once, then is disabled when the route says 404', async () => {
    const { audio, player, state, tap, checks } = setup(async () => 'missing');
    tap(404);
    audio.fail(); // the error event and the rejected play() of one load: the route is asked once
    expect(state()).toEqual({ key: null, status: 'idle' });
    await settle();
    expect(checks).toHaveBeenCalledTimes(1);
    expect(checks).toHaveBeenCalledWith(404);
    expect([...player.snapshot().missing]).toEqual([404]);
    tap(404);
    expect(audio.srcs).toHaveLength(1); // disabled: a tap does nothing
    // Others still play.
    tap(5);
    audio.start();
    await settle();
    expect(state()).toEqual({ key: 't5', status: 'playing' });
  });

  it('a load that failed for any other reason (Deezer down, the network) leaves play ready for another tap', async () => {
    const { audio, player, state, tap, checks } = setup(async () => 'retry');
    tap(7);
    audio.fail();
    await settle();
    expect(checks).toHaveBeenCalledWith(7);
    expect(state()).toEqual({ key: null, status: 'idle' });
    expect(player.snapshot().missing.size).toBe(0);
    tap(7);
    expect(audio.srcs).toEqual(['/api/preview/7', '/api/preview/7']);
    audio.start();
    await settle();
    expect(state()).toEqual({ key: 't7', status: 'playing' });
  });

  it('a song that played and then broke off goes back to play without asking the route, and a tap starts it afresh', async () => {
    const { audio, player, state, tap, checks } = setup(async () => 'missing');
    tap(7);
    audio.start();
    await settle();
    audio.breakOff();
    await settle();
    expect(state()).toEqual({ key: null, status: 'idle' });
    expect(checks).not.toHaveBeenCalled();
    expect(player.snapshot().missing.size).toBe(0);
    tap(7);
    expect(audio.srcs).toEqual(['/api/preview/7', '/api/preview/7']);
  });

  it('a play() the browser refused goes back to play, ready for another tap, without disabling the song', async () => {
    const { audio, player, state, tap, checks } = setup();
    tap(1);
    audio.refuse();
    await settle();
    expect(state()).toEqual({ key: null, status: 'idle' });
    expect(player.snapshot().missing.size).toBe(0);
    expect(checks).not.toHaveBeenCalled();
  });

  it('a failure of a load already replaced by a newer tap changes nothing', async () => {
    const { audio, player, state, tap } = setup();
    tap(1);
    tap(2);
    audio.start();
    await settle();
    expect(state()).toEqual({ key: 't2', status: 'playing' });
    expect(player.snapshot().missing.size).toBe(0);
  });

  it('shows paused when something else pauses it (the phone, headphones), and play again at the end', async () => {
    const { audio, player, state, tap } = setup();
    tap(1);
    audio.start();
    await settle();
    audio.pause();
    await settle();
    expect(state()).toEqual({ key: 't1', status: 'paused' });
    tap(1);
    audio.start();
    await settle();
    audio.finish();
    expect(state()).toEqual({ key: null, status: 'idle' });
    expect(player.progress()).toBe(0);
    // Played to its end, a tap starts it from the top.
    tap(1);
    expect(audio.srcs).toEqual(['/api/preview/1', '/api/preview/1']);
  });

  it('shows paused when the phone interrupts it while it is still loading (a call), not a silent pause button', async () => {
    const { audio, state, tap } = setup();
    tap(1);
    audio.interrupt();
    await settle();
    expect(state()).toEqual({ key: 't1', status: 'paused' });
    tap(1);
    expect(state()).toEqual({ key: 't1', status: 'loading' });
  });

  it('shows playing again when the lock screen or headphones resume it, but not for a stale event after our pause', async () => {
    const { audio, state, tap } = setup();
    tap(1);
    audio.start();
    await settle();
    tap(1); // our pause
    audio.latePlaying(); // queued before the pause, handled after it: the element is paused
    expect(state()).toEqual({ key: 't1', status: 'paused' });
    audio.resumeFromOutside();
    expect(state()).toEqual({ key: 't1', status: 'playing' });
  });

  it('after a long pause, or a load that failed while paused, a resume starts from a fresh link at the same spot', async () => {
    const { audio, state, tap, wait } = setup();
    tap(1);
    audio.start();
    await settle();
    audio.currentTime = 9;
    tap(1); // pause
    wait(RELOAD_AFTER_PAUSE_MS - 1);
    tap(1); // a short pause: the same load resumes
    expect(audio.srcs).toHaveLength(1);
    audio.start();
    await settle();

    audio.currentTime = 14;
    tap(1); // pause
    wait(RELOAD_AFTER_PAUSE_MS + 1);
    tap(1); // the link may have run out
    expect(audio.srcs).toEqual(['/api/preview/1', '/api/preview/1']);
    expect(audio.currentTime).toBe(0);
    audio.start(); // its length is known: it seeks back
    expect(audio.currentTime).toBe(14);
    await settle();
    expect(state()).toEqual({ key: 't1', status: 'playing' });

    tap(1); // pause, then the download fails while paused
    audio.breakOff();
    expect(state()).toEqual({ key: 't1', status: 'paused' });
    tap(1);
    expect(audio.srcs).toHaveLength(3);
  });

  it('a seek left over from an earlier load never moves a later song', async () => {
    const { audio, tap, wait } = setup();
    tap(1);
    audio.start();
    await settle();
    audio.currentTime = 20;
    tap(1);
    wait(RELOAD_AFTER_PAUSE_MS + 1);
    tap(1); // reload of t1, to seek to 20 once loaded
    tap(2); // a new song before t1 loaded
    audio.start();
    expect(audio.currentTime).toBe(0);
  });

  it('holds a row, not a Deezer track: two rows with the same track never both show it, and one leaving keeps the other playing', async () => {
    const { audio, player, state, tap } = setup();
    tap(1, 999);
    audio.start();
    await settle();
    expect(state()).toEqual({ key: 't1', status: 'playing' });
    player.release('t2'); // the other row with track 999 leaves the list
    expect(state()).toEqual({ key: 't1', status: 'playing' });
    expect(audio.paused).toBe(false);
    tap(2, 999); // its twin starts the same preview from the top, as its own row
    expect(state()).toEqual({ key: 't2', status: 'loading' });
  });

  it('stops when the row it holds goes away, and ignores rows it does not hold', async () => {
    const { audio, player, state, tap } = setup();
    player.release('t1'); // nothing held, no element yet
    tap(1);
    audio.start();
    await settle();
    player.release('t2');
    expect(state()).toEqual({ key: 't1', status: 'playing' });
    player.release('t1');
    expect(state()).toEqual({ key: null, status: 'idle' });
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
    expect(audio.log.slice(-2)).toEqual(['pause', 'load']);
    await settle();
    expect(state()).toEqual({ key: null, status: 'idle' });
  });

  it('tells subscribers about each change, and stops when they unsubscribe', async () => {
    const { audio, player, tap } = setup();
    const seen: string[] = [];
    const off = player.subscribe(() => seen.push(player.snapshot().status));
    tap(1);
    audio.start();
    await settle();
    off();
    tap(1);
    expect(seen).toEqual(['loading', 'playing']);
  });

  it('reports progress only while it holds a song with a known length', async () => {
    const { audio, player, tap } = setup();
    expect(player.progress()).toBe(0);
    tap(1);
    expect(player.progress()).toBe(0); // length unknown yet
    audio.start(30);
    audio.currentTime = 15;
    expect(player.progress()).toBe(0.5);
  });
});
