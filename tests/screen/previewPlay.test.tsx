// @vitest-environment jsdom
// QWW-57's review items on the ▶ (Quinn-Wai, 11 Nov), with the player's audio faked:
//   R16  while a row's preview plays, the share of it that has played goes to the row's element (--preview-progress), a frame at a time,
//        for CSS to draw the pink sweep over the title; it holds where a pause stopped it, resets when the preview ends or another row
//        plays, and draws nothing else again (no React state per frame)
//   R17  the ▶'s ring fills over the preview: empty at the start, the whole circle as the preview reaches its end, empty again after
//   R27  the same ▶, larger, as the song page's first action: "Play 30 s", before the range chart and before Find on Spotify, on the
//        one player the list's rows use, stopped when the page goes
// jsdom applies no CSS, so what is drawn (the circle, the sweep, the sizes, the outline) is tests/e2e/setlist-play.spec.ts's; here is what
// is in the DOM, what is written to it, and when.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewButton, PreviewPlayerContext, usePreviewProgress } from '../../src/components/PreviewButton';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import { SongDetail } from '../../src/components/SongDetail';
import type { Match } from '../../src/lib/contracts';
import { createPreviewPlayer } from '../../src/lib/client/preview';
import type { SetlistSong } from '../../src/lib/setlist/types';
import { match as fixtureMatch } from '../fixtures/screen';
import { FakeAudio, settle } from '../helpers/fakeAudio';
import { RANGE, rankedSong, setlistProps } from '../helpers/setlist';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function withPlayer(onStart?: (key: string, position: number | undefined) => void) {
  const audio = new FakeAudio();
  const player = createPreviewPlayer({ makeAudio: () => audio as unknown as HTMLAudioElement, check: async () => 'retry', onStart });
  const wrap = (ui: ReactNode) => <PreviewPlayerContext.Provider value={player}>{ui}</PreviewPlayerContext.Provider>;
  return { audio, player, wrap };
}

/** Taps the button called `name` and lets the preview make its first sound. */
async function playFrom(audio: FakeAudio, name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  await act(async () => {
    audio.start();
    await settle();
  });
}

/** The page's animation frames by hand: nothing is drawn by one until a test says a frame has come. */
function frames() {
  let next = 1;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.set(next, cb);
    return next++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => void pending.delete(id));
  return {
    /** One frame: what was waiting for it runs (and asks for the next). */
    next() {
      const run = [...pending.values()];
      pending.clear();
      for (const cb of run) cb(0);
    },
    waiting: () => pending.size,
  };
}

// ---- R16: the progress goes to the row ----

/** A row's element with its ▶, as SongRow makes it: the preview's progress goes to the element. */
function Row({ id, deezerId }: { id: string; deezerId: number }) {
  const li = useRef<HTMLLIElement>(null);
  usePreviewProgress(id, li);
  return (
    <li ref={li} data-id={id}>
      <PreviewButton id={id} deezerId={deezerId} title={id} artist="X" />
    </li>
  );
}

const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
const progressOf = (id: string) => rowEl(id).style.getPropertyValue('--preview-progress');

describe('the row of a playing preview (R16)', () => {
  it('has no progress before it plays, and nothing while it loads', () => {
    const { audio, wrap } = withPlayer();
    frames();
    render(wrap(<Row id="t1" deezerId={7} />));
    expect(progressOf('t1')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Play t1 by X' }));
    expect(audio.log).toContain('play');
    expect(progressOf('t1')).toBe('');
  });

  it('gets the share played as --preview-progress, a frame at a time while the preview plays', async () => {
    const { audio, wrap } = withPlayer();
    const clock = frames();
    render(wrap(<Row id="t1" deezerId={7} />));
    await playFrom(audio, 'Play t1 by X');
    audio.currentTime = 7.5;
    clock.next();
    expect(progressOf('t1')).toBe('0.25');
    audio.currentTime = 15;
    clock.next();
    expect(progressOf('t1')).toBe('0.5');
    // Nothing is drawn between frames.
    audio.currentTime = 24;
    expect(progressOf('t1')).toBe('0.5');
    clock.next();
    expect(progressOf('t1')).toBe('0.8');
  });

  it('holds where a pause stopped it, asks for no frames while it is paused, and carries on from there', async () => {
    const { audio, wrap } = withPlayer();
    const clock = frames();
    render(wrap(<Row id="t1" deezerId={7} />));
    await playFrom(audio, 'Play t1 by X');
    audio.currentTime = 15;
    clock.next();
    fireEvent.click(screen.getByRole('button', { name: 'Pause t1 by X' }));
    expect(screen.getByRole('button', { name: 'Play t1 by X' }).getAttribute('data-preview')).toBe('paused');
    expect(progressOf('t1')).toBe('0.5');
    expect(clock.waiting()).toBe(0);
    // Resumed: it is still where it was while it loads, and moves again when it sounds.
    fireEvent.click(screen.getByRole('button', { name: 'Play t1 by X' }));
    expect(progressOf('t1')).toBe('0.5');
    await act(async () => {
      audio.start();
      await settle();
    });
    audio.currentTime = 18;
    clock.next();
    expect(progressOf('t1')).toBe('0.6');
  });

  it('resets when the preview ends: the row has no progress again, and no frame is asked for', async () => {
    const { audio, wrap } = withPlayer();
    const clock = frames();
    render(wrap(<Row id="t1" deezerId={7} />));
    await playFrom(audio, 'Play t1 by X');
    audio.currentTime = 30;
    clock.next();
    expect(progressOf('t1')).toBe('1');
    act(() => audio.finish());
    expect(progressOf('t1')).toBe('');
    expect(clock.waiting()).toBe(0);
    // And it starts from nothing when it is played again.
    fireEvent.click(screen.getByRole('button', { name: 'Play t1 by X' }));
    expect(progressOf('t1')).toBe('');
  });

  it('resets when another row plays: the first row loses its progress, and the second starts from none', async () => {
    const { audio, wrap } = withPlayer();
    const clock = frames();
    render(
      wrap(
        <>
          <Row id="t1" deezerId={1} />
          <Row id="t2" deezerId={2} />
        </>,
      ),
    );
    await playFrom(audio, 'Play t1 by X');
    audio.currentTime = 15;
    clock.next();
    expect(progressOf('t1')).toBe('0.5');
    expect(progressOf('t2')).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Play t2 by X' }));
    expect(progressOf('t1')).toBe('');
    expect(progressOf('t2')).toBe('');
    await act(async () => {
      audio.start();
      await settle();
    });
    audio.currentTime = 3;
    clock.next();
    expect(progressOf('t2')).toBe('0.1');
    expect(progressOf('t1')).toBe('');
    // Only the row that plays asks for frames.
    expect(clock.waiting()).toBe(2); // its own, and its ▶'s ring
  });

  it('resets when the preview fails to load, and never moved before it sounded', async () => {
    const { audio, wrap } = withPlayer();
    frames();
    render(wrap(<Row id="t1" deezerId={7} />));
    fireEvent.click(screen.getByRole('button', { name: 'Play t1 by X' }));
    await act(async () => {
      audio.fail();
      await settle();
    });
    expect(progressOf('t1')).toBe('');
    expect(screen.getByRole('button', { name: /t1 by X$/ }).getAttribute('data-preview')).toMatch(/idle|unavailable/);
  });

  it('stops asking for frames when its row goes, and leaves nothing on the element', async () => {
    const { audio, wrap } = withPlayer();
    const clock = frames();
    const { unmount } = render(wrap(<Row id="t1" deezerId={7} />));
    await playFrom(audio, 'Play t1 by X');
    audio.currentTime = 15;
    clock.next();
    const li = rowEl('t1');
    expect(li.style.getPropertyValue('--preview-progress')).toBe('0.5');
    unmount();
    expect(clock.waiting()).toBe(0);
    expect(li.style.getPropertyValue('--preview-progress')).toBe('');
  });

  it('is in the tuner\'s rows, on the row\'s own element, and a tick of the preview does not draw the list again', async () => {
    const { audio, wrap } = withPlayer();
    const clock = frames();
    const songs: SetlistSong[] = [
      { ...rankedSong('t0', { title: 'Plastic Love', artist: 'Mariya Takeuchi' }), match: { ...rankedSong('t0', { title: 'Plastic Love', artist: 'Mariya Takeuchi' }).match, deezerId: 101 } },
      rankedSong('t1', { title: 'Lemon', artist: 'Kenshi Yonezu' }),
    ];
    const renderPlay = vi.fn((m: Match, position: number): ReactNode => (
      <PreviewButton id={m.track.id} deezerId={m.deezerId} title={m.track.title} artist={m.track.artist} position={position} />
    ));
    render(wrap(<SetlistScreen {...setlistProps(RANGE, songs, { renderPlay })} />));
    const drawn = renderPlay.mock.calls.length;
    expect(drawn).toBeGreaterThan(0);
    const row = document.querySelector<HTMLElement>('[data-row][data-id="t0"]')!;
    const other = document.querySelector<HTMLElement>('[data-row][data-id="t1"]')!;

    await playFrom(audio, 'Play Plastic Love by Mariya Takeuchi');
    // The preview starting redraws the ▶ that plays, not the list.
    expect(renderPlay.mock.calls.length).toBe(drawn);
    for (let second = 1; second <= 30; second++) {
      audio.currentTime = second;
      clock.next();
    }
    expect(row.style.getPropertyValue('--preview-progress')).toBe('1');
    expect(other.style.getPropertyValue('--preview-progress')).toBe('');
    expect(renderPlay.mock.calls.length).toBe(drawn);
  });
});

// ---- R17: the ring ----

describe("the ▶'s ring (R17)", () => {
  const RING = 2 * Math.PI * 16.5;

  it('is a track circle and a fill that follows the preview: empty at the start, the whole circle as it ends, empty again after', async () => {
    const { audio, wrap } = withPlayer();
    const clock = frames();
    render(wrap(<PreviewButton id="t1" deezerId={7} title="Africa" artist="Toto" />));
    const circles = screen.getByRole('button').querySelectorAll('circle');
    expect(circles).toHaveLength(2);
    const fill = circles[1] as SVGCircleElement;
    const offset = () => Number.parseFloat(fill.style.strokeDashoffset);
    expect(offset()).toBeCloseTo(RING, 6);

    await playFrom(audio, 'Play Africa by Toto');
    audio.currentTime = 7.5;
    clock.next();
    expect(offset()).toBeCloseTo(RING * 0.75, 6);
    audio.currentTime = 15;
    clock.next();
    expect(offset()).toBeCloseTo(RING * 0.5, 6);
    // The last frame before the end draws the whole circle (nothing is left to run), and the ending takes it away.
    audio.currentTime = 30;
    clock.next();
    expect(offset()).toBeCloseTo(0, 6);
    act(() => audio.finish());
    expect(offset()).toBeCloseTo(RING, 6);
  });

  it('stays where a pause stopped it and is empty for a ▶ that is not playing', async () => {
    const { audio, wrap } = withPlayer();
    const clock = frames();
    render(
      wrap(
        <>
          <PreviewButton id="t1" deezerId={1} title="One" artist="X" />
          <PreviewButton id="t2" deezerId={2} title="Two" artist="X" />
        </>,
      ),
    );
    const fillOf = (name: string) => Number.parseFloat((screen.getByRole('button', { name }).querySelectorAll('circle')[1] as SVGCircleElement).style.strokeDashoffset);
    await playFrom(audio, 'Play One by X');
    audio.currentTime = 10;
    clock.next();
    expect(fillOf('Pause One by X')).toBeCloseTo(RING * (1 - 10 / 30), 6);
    expect(fillOf('Play Two by X')).toBeCloseTo(RING, 6);
    fireEvent.click(screen.getByRole('button', { name: 'Pause One by X' }));
    expect(fillOf('Play One by X')).toBeCloseTo(RING * (1 - 10 / 30), 6);
    expect(clock.waiting()).toBe(0);
    // Another row plays: the first ring is empty.
    fireEvent.click(screen.getByRole('button', { name: 'Play Two by X' }));
    expect(fillOf('Play One by X')).toBeCloseTo(RING, 6);
  });
});

// ---- R27: the song page's ▶ ----

const withDeezer = (m: Match, deezerId?: number): Match => (deezerId === undefined ? m : { ...m, deezerId });
/** A catalogue song, whose Spotify link is a search (no player to embed), so its page has the "Find on Spotify" link. */
const catalogue = (deezerId?: number): Match => {
  const m = fixtureMatch(4); // Dancing Queen
  return withDeezer({ ...m, track: { ...m.track, id: 'cat:abba|dancing queen', spotifyUrl: 'https://open.spotify.com/search/ABBA%20Dancing%20Queen' } }, deezerId);
};
const page = (match: Match) => <SongDetail match={match} userRange={RANGE} feedback={undefined} onFeedback={vi.fn()} onBack={vi.fn()} />;
/** True when `b` comes after `a` in the page. */
const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the large ▶ (R27)', () => {
  it('is named by its words, which are on the screen under the circle: Play 30 s, Pause while it sounds, Play 30 s when paused', async () => {
    const { audio, wrap } = withPlayer();
    frames();
    render(wrap(<PreviewButton id="t1" deezerId={7} title="Africa" artist="Toto" large />));
    const button = () => screen.getByRole('button');
    const words = () => button().querySelector('span')?.textContent;
    expect(button().getAttribute('aria-label')).toBe('Play 30 s');
    expect(words()).toBe('Play 30 s');
    // The same ring as the row's: a track circle and a fill.
    expect(button().querySelectorAll('circle')).toHaveLength(2);

    fireEvent.click(button());
    expect(button().getAttribute('aria-label')).toBe('Pause'); // loading
    expect(words()).toBe('Pause');
    await act(async () => {
      audio.start();
      await settle();
    });
    expect(button().getAttribute('data-preview')).toBe('playing');
    expect(words()).toBe('Pause');
    fireEvent.click(button());
    expect(button().getAttribute('data-preview')).toBe('paused');
    expect(button().getAttribute('aria-label')).toBe('Play 30 s');
    expect(words()).toBe('Play 30 s');
  });

  it("says there is no preview, disabled, for a song Deezer has none for, with no hover text repeating the words", () => {
    const { wrap } = withPlayer();
    render(wrap(<PreviewButton id="t1" deezerId={undefined} title="Lemon" artist="Kenshi Yonezu" large />));
    const button = screen.getByRole('button', { name: 'No preview' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('data-preview')).toBe('unavailable');
    expect(button.getAttribute('title')).toBeNull();
    expect(button.textContent).toBe('No preview');
  });

  it('the small one in a row is as it was: named after its song, with no words of its own', () => {
    const { wrap } = withPlayer();
    render(wrap(<PreviewButton id="t1" deezerId={7} title="Africa" artist="Toto" />));
    const button = screen.getByRole('button', { name: 'Play Africa by Toto' });
    expect(button.textContent).toBe('');
    expect(button.className).not.toMatch(/previewLarge/);
  });
});

describe("the song page's ▶ (R27)", () => {
  it('is the first action under the title: before the range chart, and before Find on Spotify, which is right under it, in the page and in the Tab order', () => {
    const { wrap } = withPlayer();
    frames();
    const { container } = render(wrap(page(catalogue(321))));
    const title = screen.getByRole('heading', { name: 'Dancing Queen' });
    const button = screen.getByRole('button', { name: 'Play 30 s' });
    const link = screen.getByRole('link', { name: 'Find on Spotify' });
    const chart = screen.getByRole('img', { name: /^Song goes from/ });
    expect(follows(title, button)).toBe(true);
    expect(follows(button, link)).toBe(true);
    expect(follows(link, chart)).toBe(true);
    // The Tab order is the page's order: Back, the ▶, Find on Spotify, then the thumbs.
    const tabs = [...container.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')].map((e) => e.getAttribute('aria-label') ?? e.textContent);
    expect(tabs.slice(0, 4)).toEqual(['Back to songs', 'Play 30 s', 'Find on Spotify', 'It went well']);
  });

  it("leaves Spotify's own player where it was, after the range chart, when the song has one to embed; the ▶ is first all the same", () => {
    const { wrap } = withPlayer();
    frames();
    render(wrap(page(withDeezer(fixtureMatch(0), 55))));
    const button = screen.getByRole('button', { name: 'Play 30 s' });
    const chart = screen.getByRole('img', { name: /^Song goes from/ });
    const frame = screen.getByTitle(/^Spotify player/);
    expect(follows(screen.getByRole('heading', { name: 'Plastic Love' }), button)).toBe(true);
    expect(follows(button, chart)).toBe(true);
    expect(follows(chart, frame)).toBe(true);
    expect(screen.queryByRole('link', { name: /Spotify/ })).toBeNull();
  });

  it('plays the song on the page\'s one player, and the event log hears it with no place in the list (QWW-51)', async () => {
    const onStart = vi.fn();
    const { audio, wrap } = withPlayer(onStart);
    frames();
    render(wrap(page(catalogue(321))));
    fireEvent.click(screen.getByRole('button', { name: 'Play 30 s' }));
    expect(audio.src).toBe('/api/preview/321');
    expect(onStart).not.toHaveBeenCalled();
    await act(async () => {
      audio.start();
      await settle();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith('cat:abba|dancing queen', undefined);
    expect(screen.getByRole('button', { name: 'Pause' }).getAttribute('data-preview')).toBe('playing');
  });

  it("is one player with the rows' ▶: starting the page's stops a row's, and starting a row's stops the page's", async () => {
    const { audio, player, wrap } = withPlayer();
    frames();
    render(wrap(<><PreviewButton id="row" deezerId={1} title="Row" artist="X" />{page(catalogue(321))}</>));
    const state = (name: string) => screen.getByRole('button', { name }).getAttribute('data-preview');
    await playFrom(audio, 'Play Row by X');
    expect(state('Pause Row by X')).toBe('playing');
    await playFrom(audio, 'Play 30 s');
    expect(state('Play Row by X')).toBe('idle');
    expect(state('Pause')).toBe('playing');
    expect(player.snapshot().key).toBe('cat:abba|dancing queen');
    fireEvent.click(screen.getByRole('button', { name: 'Play Row by X' }));
    expect(state('Play 30 s')).toBe('idle');
    expect(player.snapshot().key).toBe('row');
  });

  it("stops when the page goes (the ‹ Back, or the browser's)", async () => {
    const { audio, player, wrap } = withPlayer();
    frames();
    const { unmount } = render(wrap(page(catalogue(321))));
    await playFrom(audio, 'Play 30 s');
    expect(audio.paused).toBe(false);
    unmount();
    expect(player.snapshot()).toMatchObject({ key: null, status: 'idle' });
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
  });

  it('is a disabled ▶ saying "No preview" for a song with no Deezer preview, still first on the page, and the layout is the same as for one with a preview', () => {
    const { wrap } = withPlayer();
    frames();
    const { unmount } = render(wrap(page(catalogue())));
    const none = screen.getByRole('button', { name: 'No preview' });
    expect(none).toHaveProperty('disabled', true);
    expect(follows(screen.getByRole('heading', { name: 'Dancing Queen' }), none)).toBe(true);
    expect(follows(none, screen.getByRole('link', { name: 'Find on Spotify' }))).toBe(true);
    const shape = (root: ParentNode) => [...root.querySelectorAll('button, a, [role="img"], h2')].map((e) => e.tagName);
    const withNone = shape(document.body);
    unmount();
    render(wrap(page(catalogue(321))));
    expect(shape(document.body)).toEqual(withNone);
  });
});
