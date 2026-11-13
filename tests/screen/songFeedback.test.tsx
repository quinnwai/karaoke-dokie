// @vitest-environment jsdom
// The song page's thumbs (R26, QWW-57): a like or dislike stays. After a tap "Thanks! That helps." appears and stays, and on later
// visits the picked thumb shows as selected and cannot be changed. It is kept on the device for each song (the store is
// tests/screen/feedbackStore.test.ts's); here is what the page does with it. The requests are the ones it always sent.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeApp } from '../../src/components/KaraokeApp';
import { SongDetail } from '../../src/components/SongDetail';
import type { Api } from '../../src/lib/client/api';
import type { Mic, MicRecorder } from '../../src/lib/client/mic';
import type { MeResponse, RecommendationsResponse, VocalRange } from '../../src/lib/contracts';
import type { SetlistEngine } from '../../src/lib/setlist/engine';
import { allMatches, knownSongs, match, me, recommendationsPage } from '../fixtures/screen';
import { ranked, response } from '../helpers/setlist';

const RANGE: VocalRange = { low: 45, high: 72, source: 'test' };
const WELL = 'It went well';
const NOT_WELL = "It didn't go well";

const thumb = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const thanks = () => screen.queryByText('Thanks! That helps.');
const question = () => screen.queryByText('How’d it go?');
/** What a singer can read off the two thumbs. */
const thumbs = () => ({
  well: { disabled: thumb(WELL).disabled, pressed: thumb(WELL).getAttribute('aria-pressed') },
  notWell: { disabled: thumb(NOT_WELL).disabled, pressed: thumb(NOT_WELL).getAttribute('aria-pressed') },
});
const OPEN = { disabled: false, pressed: 'false' };
const PICKED = { disabled: true, pressed: 'true' };
const LOCKED = { disabled: true, pressed: 'false' };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.pushState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SongDetail: the thumbs', () => {
  function page(feedback: 'up' | 'down' | undefined, onFeedback: (t: 'up' | 'down') => void = vi.fn()) {
    render(<SongDetail match={match(0)} userRange={RANGE} feedback={feedback} onFeedback={onFeedback} onBack={vi.fn()} />);
    return onFeedback;
  }

  it('asks before there is an answer: both thumbs can be tapped, neither is picked, and there is no thanks', () => {
    page(undefined);
    expect(question()).not.toBeNull();
    expect(thanks()).toBeNull();
    expect(thumbs()).toEqual({ well: OPEN, notWell: OPEN });
  });

  it.each([
    ['up', { well: PICKED, notWell: LOCKED }],
    ['down', { well: LOCKED, notWell: PICKED }],
  ] as const)('after a %s: the picked thumb is pressed, both are disabled, and the thanks line takes the question’s place', (picked, expected) => {
    page(picked);
    expect(thumbs()).toEqual(expected);
    expect(thanks()).not.toBeNull();
    expect(question()).toBeNull();
    // A live region, so a screen reader says it once when it changes; it is the same element the question was in.
    expect(thanks()!.getAttribute('aria-live')).toBe('polite');
  });

  it('keeps the thumbs’ names, so a screen reader finds the same two buttons before and after', () => {
    page('up');
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label')).filter((n) => n === WELL || n === NOT_WELL)).toEqual([WELL, NOT_WELL]);
  });

  it('draws the picked thumb filled and the other one as an outline, so what is picked is not told by colour alone', () => {
    page('down');
    const fill = (name: string) => thumb(name).querySelector('path')!.getAttribute('fill');
    expect(fill(NOT_WELL)).toBe('currentColor');
    expect(fill(WELL)).toBe('none');
  });

  it.each([
    [WELL, 'up'],
    [NOT_WELL, 'down'],
  ] as const)('a tap on %s says %s, once', (name, thumbsUp) => {
    const onFeedback = page(undefined, vi.fn());
    fireEvent.click(thumb(name));
    expect(onFeedback).toHaveBeenCalledTimes(1);
    expect(onFeedback).toHaveBeenCalledWith(thumbsUp);
  });

  it('a tap on a thumb that cannot be changed says nothing, whichever it is', () => {
    const onFeedback = page('up', vi.fn());
    fireEvent.click(thumb(WELL));
    fireEvent.click(thumb(NOT_WELL));
    expect(onFeedback).not.toHaveBeenCalled();
  });
});

// ---- on the app ----

function fakeApi(user: MeResponse | null, pageOf: () => RecommendationsResponse = () => allMatches()) {
  let current = user;
  return {
    me: vi.fn(async () => current),
    logout: vi.fn(async () => {
      current = null;
    }),
    saveRange: vi.fn(async (range: VocalRange) => {
      if (current) current = { ...current, range };
    }),
    recommendations: vi.fn(async (offset: number) => recommendationsPage(offset)),
    allRecommendations: vi.fn(async () => pageOf()),
    catalogue: vi.fn(async (_range: { low: number; high: number }) => pageOf()),
    knownSongs: vi.fn(async () => knownSongs()),
    feedback: vi.fn(async (_body: Parameters<Api['feedback']>[0]) => {}),
    catalogueFeedback: vi.fn(async (_body: Parameters<Api['catalogueFeedback']>[0]) => {}),
  } satisfies Api;
}

const recorder: MicRecorder = {
  sampleRate: 44100,
  reset: () => {},
  latest: () => new Float32Array(0),
  take: () => new Float32Array(0),
  live: () => true,
  running: () => true,
  resume: () => {},
  close: () => {},
};
const mic: Mic = { permission: async () => 'prompt', open: async () => recorder };

/** One visit: the app on the tuner, as it opens for a signed-in singer (or, with `user` null, a singer with the range kept on the device). */
async function visit(user: MeResponse | null = me(RANGE), pageOf?: () => RecommendationsResponse) {
  if (user === null) localStorage.setItem('kd.range', JSON.stringify({ low: RANGE.low, high: RANGE.high }));
  const api = fakeApi(user, pageOf);
  const engine: SetlistEngine = { rank: async () => response((pageOf?.() ?? allMatches()).matches.map((m) => ranked(m))) };
  const shown = render(<KaraokeApp api={api} track={{ track: vi.fn(), flush: async () => {} }} mic={mic} quietMs={5} setlistEngine={engine} />);
  await screen.findByText('Plastic Love');
  return { api, unmount: shown.unmount };
}
const open = async (title: RegExp) => void fireEvent.click(await screen.findByRole('button', { name: title }));
const backToSongs = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Back to songs' }));
  await screen.findByText('Plastic Love');
};
const PLASTIC_LOVE = /^Plastic Love/; // t0
const LEMON = /^Lemon/; // t1
const YORU = /^Yoru ni Kakeru/; // t2

describe('a like or dislike stays', () => {
  it('after a tap: the thanks line appears and the picked thumb is selected, and both thumbs can no longer be tapped', async () => {
    const { api } = await visit();
    await open(LEMON);
    expect(thumbs()).toEqual({ well: OPEN, notWell: OPEN });
    fireEvent.click(thumb(WELL));
    expect(thanks()).not.toBeNull();
    expect(thumbs()).toEqual({ well: PICKED, notWell: LOCKED });
    expect(api.feedback).toHaveBeenCalledTimes(1);
    expect(api.feedback).toHaveBeenCalledWith(expect.objectContaining({ trackId: 't1', thumbs: 'up' }));
    expect(localStorage.getItem('kd.feedback:t1')).toBe('up');
  });

  it('tap like, leave, open another song and come back: the thumb is selected and disabled, the thanks line shows, and the other song was not rated', async () => {
    const { api } = await visit();
    await open(LEMON);
    fireEvent.click(thumb(WELL));
    await backToSongs();

    await open(YORU);
    expect(question()).not.toBeNull();
    expect(thanks()).toBeNull();
    expect(thumbs()).toEqual({ well: OPEN, notWell: OPEN });
    await backToSongs();

    await open(LEMON);
    expect(thumbs()).toEqual({ well: PICKED, notWell: LOCKED });
    expect(thanks()).not.toBeNull();
    expect(api.feedback).toHaveBeenCalledTimes(1);
  });

  it.each([
    [WELL, 'up', { well: PICKED, notWell: LOCKED }],
    [NOT_WELL, 'down', { well: LOCKED, notWell: PICKED }],
  ] as const)('a new visit, with the page loaded again: a song rated %s (%s) opens already showing it, with nothing asked of the network', async (name, stored, expected) => {
    const first = await visit();
    await open(LEMON);
    fireEvent.click(thumb(name));
    expect(localStorage.getItem('kd.feedback:t1')).toBe(stored);
    first.unmount();

    // Everything the first visit knew is gone; what the device kept is not.
    const { api } = await visit();
    await open(LEMON);
    // Straight away, in the same tick as the tap that opened the page: no answer from the server to wait for.
    expect(thumbs()).toEqual(expected);
    expect(thanks()).not.toBeNull();
    expect(api.feedback).not.toHaveBeenCalled();
    expect(api.catalogueFeedback).not.toHaveBeenCalled();
    // And a song that was not rated is as it was.
    await backToSongs();
    await open(YORU);
    expect(thumbs()).toEqual({ well: OPEN, notWell: OPEN });
  });

  it('a singer who stays signed out keeps it too, for a catalogue song by the id the catalogue gives it', async () => {
    const catalogue = () => {
      const page = allMatches();
      return { ...page, matches: page.matches.map((m) => ({ ...m, track: { ...m.track, id: `cat:${m.track.artist.toLowerCase()}|${m.track.title.toLowerCase()}` } })) };
    };
    const first = await visit(null, catalogue);
    await open(PLASTIC_LOVE);
    fireEvent.click(thumb(NOT_WELL));
    expect(first.api.catalogueFeedback).toHaveBeenCalledTimes(1);
    expect(first.api.feedback).not.toHaveBeenCalled();
    expect(localStorage.getItem('kd.feedback:cat:mariya takeuchi|plastic love')).toBe('down');
    first.unmount();

    const second = await visit(null, catalogue);
    await open(PLASTIC_LOVE);
    expect(thumbs()).toEqual({ well: LOCKED, notWell: PICKED });
    expect(thanks()).not.toBeNull();
    expect(second.api.catalogueFeedback).not.toHaveBeenCalled();
  });

  it('is not shared between songs that have different ids, even when the title is the same', async () => {
    // A library song and the catalogue's copy of it are two songs here: the id is what the device keeps it under.
    localStorage.setItem('kd.feedback:cat:mariya takeuchi|plastic love', 'up');
    await visit();
    await open(PLASTIC_LOVE); // t0
    expect(thumbs()).toEqual({ well: OPEN, notWell: OPEN });
  });

  it('ignores a stored value that is not up or down: the page opens as if the song had not been rated', async () => {
    localStorage.setItem('kd.feedback:t1', 'sideways');
    await visit();
    await open(LEMON);
    expect(thumbs()).toEqual({ well: OPEN, notWell: OPEN });
    expect(thanks()).toBeNull();
    fireEvent.click(thumb(NOT_WELL)); // and it can be rated, which replaces what was there
    expect(localStorage.getItem('kd.feedback:t1')).toBe('down');
  });

  it('takes a second tap on a rated song for nothing: no second request, and the first answer stays', async () => {
    const { api } = await visit();
    await open(LEMON);
    fireEvent.click(thumb(WELL));
    fireEvent.click(thumb(WELL));
    fireEvent.click(thumb(NOT_WELL));
    expect(api.feedback).toHaveBeenCalledTimes(1);
    expect(thumbs()).toEqual({ well: PICKED, notWell: LOCKED });
    expect(localStorage.getItem('kd.feedback:t1')).toBe('up');
  });

  it('takes the second tap of a double tap for nothing, even when it lands before the page has drawn the first', async () => {
    const { api } = await visit();
    await open(LEMON);
    const [well, notWell] = [thumb(WELL), thumb(NOT_WELL)];
    // Both taps in one act(): React has drawn nothing between them, so the thumbs still look tappable to the second.
    act(() => {
      fireEvent.click(well);
      fireEvent.click(notWell);
    });
    expect(api.feedback).toHaveBeenCalledTimes(1);
    expect(api.feedback).toHaveBeenCalledWith(expect.objectContaining({ thumbs: 'up' }));
    expect(localStorage.getItem('kd.feedback:t1')).toBe('up');
    expect(thumbs()).toEqual({ well: PICKED, notWell: LOCKED });
  });

  it('shows what another tab kept since this one opened: the device’s store is read when the song page opens, not only when the app does', async () => {
    await visit();
    localStorage.setItem('kd.feedback:t1', 'up'); // the other tab
    await open(LEMON);
    expect(thumbs()).toEqual({ well: PICKED, notWell: LOCKED });
  });

  describe('where storage is blocked (a private window)', () => {
    /** Everything but the feedback keys works, as in a browser that lets the page keep a range but not this. */
    function blockFeedbackKeys() {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      const blocked = (key: string) => key.startsWith('kd.feedback');
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        if (blocked(key)) throw new DOMException('denied', 'SecurityError');
        return get.call(this, key);
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
        if (blocked(key)) throw new DOMException('full', 'QuotaExceededError');
        set.call(this, key, value);
      });
    }

    it('the page opens, a tap still says thanks and sends its request, and the answer holds for the rest of the visit', async () => {
      blockFeedbackKeys();
      const { api } = await visit();
      await open(LEMON);
      expect(thumbs()).toEqual({ well: OPEN, notWell: OPEN });
      fireEvent.click(thumb(WELL));
      expect(api.feedback).toHaveBeenCalledTimes(1);
      expect(thumbs()).toEqual({ well: PICKED, notWell: LOCKED });
      expect(thanks()).not.toBeNull();
      // The app's own memory of the visit still has it; only the device forgets.
      await backToSongs();
      await open(LEMON);
      expect(thumbs()).toEqual({ well: PICKED, notWell: LOCKED });
    });

    it('with no localStorage at all, the page opens and a tap works the same', async () => {
      const { api } = await visit();
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      await open(LEMON);
      expect(thumbs()).toEqual({ well: OPEN, notWell: OPEN });
      fireEvent.click(thumb(NOT_WELL));
      await waitFor(() => expect(api.feedback).toHaveBeenCalledTimes(1));
      expect(thumbs()).toEqual({ well: LOCKED, notWell: PICKED });
    });
  });

  it('does not touch the other songs’ answers when one is given', async () => {
    localStorage.setItem('kd.feedback:t2', 'down');
    await visit();
    await open(LEMON);
    fireEvent.click(thumb(WELL));
    expect(localStorage.getItem('kd.feedback:t2')).toBe('down');
    expect(localStorage.getItem('kd.feedback:t1')).toBe('up');
    const kept: Record<string, string | null> = {};
    for (let i = 0; i < localStorage.length; i++) kept[localStorage.key(i)!] = localStorage.getItem(localStorage.key(i)!);
    expect(Object.keys(kept).filter((k) => k.startsWith('kd.feedback')).sort()).toEqual(['kd.feedback:t1', 'kd.feedback:t2']);
  });
});
