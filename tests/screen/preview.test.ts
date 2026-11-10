// The shared preview player behind every row's play button (QWW-48).
import { describe, expect, it } from 'vitest';
import { createPreviewPlayer, previewSrc } from '../../src/lib/client/preview';
import { FakeAudio, settle } from '../helpers/fakeAudio';

function setup() {
  const audio = new FakeAudio();
  let made = 0;
  const player = createPreviewPlayer(() => {
    made++;
    return audio as unknown as HTMLAudioElement;
  });
  const state = () => {
    const s = player.snapshot();
    return { id: s.id, status: s.status };
  };
  return { audio, player, state, made: () => made };
}

describe('preview player', () => {
  it('sets the address and calls play() inside the tap itself, as iOS needs, with no element until the first tap', () => {
    const { audio, player, state, made } = setup();
    expect(made()).toBe(0);
    player.toggle('3135556');
    // Both happened before toggle returned: nothing waited on a promise or a timer.
    expect(audio.log).toEqual([`src:${previewSrc('3135556')}`, 'play']);
    expect(previewSrc('3135556')).toBe('/api/preview/3135556');
    expect(state()).toEqual({ id: '3135556', status: 'loading' });
    expect(made()).toBe(1);
  });

  it('shows playing once the sound starts, pauses on a second tap and resumes on a third, where it stopped', async () => {
    const { audio, player, state } = setup();
    player.toggle('1');
    audio.start();
    await settle();
    expect(state()).toEqual({ id: '1', status: 'playing' });

    audio.currentTime = 12;
    player.toggle('1');
    expect(state()).toEqual({ id: '1', status: 'paused' });
    expect(player.progress()).toBeCloseTo(0.4);
    await settle();
    expect(state()).toEqual({ id: '1', status: 'paused' });

    player.toggle('1');
    expect(audio.srcs).toHaveLength(1); // the same load: it resumes, it does not start over
    expect(state()).toEqual({ id: '1', status: 'loading' });
    audio.start();
    await settle();
    expect(state()).toEqual({ id: '1', status: 'playing' });
    expect(audio.currentTime).toBe(12);
  });

  it('switches at once to another row, one song at a time', async () => {
    const { audio, player, state } = setup();
    player.toggle('1');
    audio.start();
    await settle();
    player.toggle('2');
    expect(audio.src).toBe('/api/preview/2');
    expect(state()).toEqual({ id: '2', status: 'loading' });
    audio.start();
    await settle();
    expect(state()).toEqual({ id: '2', status: 'playing' });
  });

  it('five taps in five seconds end with the last-tapped song playing', async () => {
    const { audio, player, state } = setup();
    const ids = ['11', '22', '33', '44', '55'];
    for (const [i, id] of ids.entries()) {
      player.toggle(id);
      // The first two get far enough to make a sound; each newer tap cuts the older load short (AbortError).
      if (i < 2) audio.start();
      await settle();
    }
    expect(state()).toEqual({ id: '55', status: 'loading' });
    audio.start();
    await settle();
    expect(state()).toEqual({ id: '55', status: 'playing' });
    expect(audio.src).toBe('/api/preview/55');
    expect(player.snapshot().failed.size).toBe(0);
  });

  it('a pause tapped before the sound starts stays paused', async () => {
    const { audio, player, state } = setup();
    player.toggle('1');
    player.toggle('1');
    await settle();
    expect(state()).toEqual({ id: '1', status: 'paused' });
    expect(audio.paused).toBe(true);
  });

  it('a preview that will not load disables that song, and its button does nothing after', async () => {
    const { audio, player, state } = setup();
    player.toggle('404');
    audio.fail();
    await settle();
    expect(state()).toEqual({ id: null, status: 'idle' });
    expect([...player.snapshot().failed]).toEqual(['404']);
    player.toggle('404');
    expect(audio.srcs).toHaveLength(1);
    // Others still play.
    player.toggle('5');
    audio.start();
    await settle();
    expect(state()).toEqual({ id: '5', status: 'playing' });
  });

  it('a play() the browser refused goes back to play, ready for another tap, without disabling the song', async () => {
    const { audio, player, state } = setup();
    player.toggle('1');
    audio.refuse();
    await settle();
    expect(state()).toEqual({ id: null, status: 'idle' });
    expect(player.snapshot().failed.size).toBe(0);
  });

  it('a failure of a load already replaced by a newer tap changes nothing', async () => {
    const { audio, player, state } = setup();
    player.toggle('1');
    player.toggle('2');
    audio.start();
    await settle();
    expect(state()).toEqual({ id: '2', status: 'playing' });
    expect(player.snapshot().failed.size).toBe(0);
  });

  it('shows paused when something else pauses it (the phone, headphones), and play again at the end', async () => {
    const { audio, player, state } = setup();
    player.toggle('1');
    audio.start();
    await settle();
    audio.pause();
    await settle();
    expect(state()).toEqual({ id: '1', status: 'paused' });
    player.toggle('1');
    audio.start();
    await settle();
    audio.finish();
    expect(state()).toEqual({ id: null, status: 'idle' });
    expect(player.progress()).toBe(0);
    // Played to its end, a tap starts it from the top.
    player.toggle('1');
    expect(audio.srcs).toEqual(['/api/preview/1', '/api/preview/1']);
  });

  it('stops when the row of the song it holds goes away, and ignores rows it does not hold', async () => {
    const { audio, player, state } = setup();
    player.release('1'); // nothing held, no element yet
    player.toggle('1');
    audio.start();
    await settle();
    player.release('2');
    expect(state()).toEqual({ id: '1', status: 'playing' });
    player.release('1');
    expect(state()).toEqual({ id: null, status: 'idle' });
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
    expect(audio.log.slice(-2)).toEqual(['pause', 'load']);
    await settle();
    expect(state()).toEqual({ id: null, status: 'idle' });
  });

  it('tells subscribers about each change, and stops when they unsubscribe', async () => {
    const { audio, player } = setup();
    const seen: string[] = [];
    const off = player.subscribe(() => seen.push(player.snapshot().status));
    player.toggle('1');
    audio.start();
    await settle();
    off();
    player.toggle('1');
    expect(seen).toEqual(['loading', 'playing']);
  });

  it('reports progress only while it holds a song with a known length', async () => {
    const { audio, player } = setup();
    expect(player.progress()).toBe(0);
    player.toggle('1');
    expect(player.progress()).toBe(0); // duration unknown yet
    audio.start(30);
    audio.currentTime = 15;
    expect(player.progress()).toBe(0.5);
  });
});
