// @vitest-environment jsdom
// The play button in each song row (QWW-48), alone and in the Setlist tuner's rows (QWW-57 moved it from the earlier results
// screen into the tuner's slot, where hovering swaps the rank number for it).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeezerCredit, PreviewButton, PreviewPlayerContext } from '../../src/components/PreviewButton';
import { SetlistScreen } from '../../src/components/setlist/SetlistScreen';
import type { Match } from '../../src/lib/contracts';
import { createPreviewPlayer, type PreviewCheck } from '../../src/lib/client/preview';
import type { SetlistSong } from '../../src/lib/setlist/types';
import { FakeAudio, settle } from '../helpers/fakeAudio';
import { RANGE, rankedSong, setlistProps } from '../helpers/setlist';

afterEach(cleanup);

function withPlayer(check: PreviewCheck = async () => 'retry') {
  const audio = new FakeAudio();
  const player = createPreviewPlayer({ makeAudio: () => audio as unknown as HTMLAudioElement, check });
  const wrap = (ui: ReactNode) => <PreviewPlayerContext.Provider value={player}>{ui}</PreviewPlayerContext.Provider>;
  return { audio, player, wrap };
}

/** A returned song that has a Deezer track. */
const withId = (song: SetlistSong, deezerId: number): SetlistSong => ({ ...song, match: { ...song.match, deezerId } });

describe('PreviewButton', () => {
  it('is a disabled button, not a broken one, for a song with nothing to play', () => {
    const { wrap } = withPlayer();
    render(wrap(<PreviewButton id="t1" deezerId={undefined} title="Lemon" artist="Kenshi Yonezu" />));
    const button = screen.getByRole('button', { name: 'No preview of Lemon by Kenshi Yonezu' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('data-preview')).toBe('unavailable');
  });

  it('plays on a tap, shows pause while it plays, and plays again after a second tap pauses it', async () => {
    const { audio, wrap } = withPlayer();
    render(wrap(<PreviewButton id="t1" deezerId={3135556} title="Africa" artist="Toto" />));
    fireEvent.click(screen.getByRole('button', { name: 'Play Africa by Toto' }));
    expect(audio.log).toEqual(['src:/api/preview/3135556', 'play']);
    const button = screen.getByRole('button', { name: 'Pause Africa by Toto' });
    expect(button.getAttribute('data-preview')).toBe('loading');
    await act(async () => {
      audio.start();
      await settle();
    });
    expect(button.getAttribute('data-preview')).toBe('playing');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Play Africa by Toto' }).getAttribute('data-preview')).toBe('paused');
  });

  it('turns disabled when its preview fails to load and the route says Deezer has none', async () => {
    const { audio, wrap } = withPlayer(async () => 'missing');
    render(wrap(<PreviewButton id="t1" deezerId={1} title="Gone" artist="Nobody" />));
    fireEvent.click(screen.getByRole('button', { name: 'Play Gone by Nobody' }));
    await act(async () => {
      audio.fail();
      await settle();
    });
    expect(screen.getByRole('button', { name: 'No preview of Gone by Nobody' })).toHaveProperty('disabled', true);
  });

  it('never passes its tap on to the row around it', () => {
    const { wrap } = withPlayer();
    const row = vi.fn();
    render(wrap(<div onClick={row}><PreviewButton id="t1" deezerId={5} title="A" artist="B" /></div>));
    fireEvent.click(screen.getByRole('button', { name: 'Play A by B' }));
    expect(row).not.toHaveBeenCalled();
  });

  it('stops its song when it goes away (the song page opened, or a filter took the row off)', async () => {
    const { audio, player, wrap } = withPlayer();
    const { unmount } = render(wrap(<PreviewButton id="t1" deezerId={7} title="A" artist="B" />));
    fireEvent.click(screen.getByRole('button', { name: 'Play A by B' }));
    await act(async () => {
      audio.start();
      await settle();
    });
    unmount();
    expect(player.snapshot()).toMatchObject({ key: null, status: 'idle' });
    expect(audio.paused).toBe(true);
  });

  it('only the button of the song playing shows pause', async () => {
    const { audio, wrap } = withPlayer();
    render(
      wrap(
        <>
          <PreviewButton id="t1" deezerId={1} title="One" artist="X" />
          <PreviewButton id="t2" deezerId={2} title="Two" artist="X" />
        </>,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play One by X' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play Two by X' }));
    await act(async () => {
      audio.start();
      await settle();
    });
    expect(screen.getByRole('button', { name: 'Play One by X' }).getAttribute('data-preview')).toBe('idle');
    expect(screen.getByRole('button', { name: 'Pause Two by X' }).getAttribute('data-preview')).toBe('playing');
  });
});

describe('two rows with one Deezer track', () => {
  it('only the tapped row shows pause, and the other leaving the list does not stop it', async () => {
    const { audio, wrap } = withPlayer();
    const { rerender } = render(
      wrap(
        <>
          <PreviewButton id="t1" deezerId={9} title="September" artist="Earth, Wind & Fire" />
          <PreviewButton id="t2" deezerId={9} title="September" artist="Earth Wind and Fire" />
        </>,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play September by Earth, Wind & Fire' }));
    await act(async () => {
      audio.start();
      await settle();
    });
    expect(screen.getByRole('button', { name: 'Pause September by Earth, Wind & Fire' }).getAttribute('data-preview')).toBe('playing');
    expect(screen.getByRole('button', { name: 'Play September by Earth Wind and Fire' }).getAttribute('data-preview')).toBe('idle');
    rerender(wrap(<PreviewButton id="t1" deezerId={9} title="September" artist="Earth, Wind & Fire" />));
    expect(screen.getByRole('button', { name: 'Pause September by Earth, Wind & Fire' }).getAttribute('data-preview')).toBe('playing');
    expect(audio.paused).toBe(false);
  });
});

describe('play button in the tuner rows', () => {
  const plastic = () => rankedSong('t0', { title: 'Plastic Love', artist: 'Mariya Takeuchi' });
  const lemon = () => rankedSong('t1', { title: 'Lemon', artist: 'Kenshi Yonezu' });
  /** What the app mounts in a row's slot (KaraokeApp's previewPlay). */
  const play = (m: Match): ReactNode => <PreviewButton id={m.track.id} deezerId={m.deezerId} title={m.track.title} artist={m.track.artist} />;
  const draw = (wrap: (ui: ReactNode) => ReactNode, songs: SetlistSong[], onSelect = vi.fn()) => {
    render(wrap(<SetlistScreen {...setlistProps(RANGE, songs, { renderPlay: play, onSelect })} />));
    return onSelect;
  };

  it('sits in the first slot of each row, plays without opening the song page, and the row still opens it', () => {
    const { audio, wrap } = withPlayer();
    const onSelect = draw(wrap, [withId(plastic(), 101), lemon()]);

    fireEvent.click(screen.getByRole('button', { name: 'Play Plastic Love by Mariya Takeuchi' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(audio.src).toBe('/api/preview/101');

    fireEvent.click(screen.getByRole('button', { name: /^Plastic Love by Mariya Takeuchi,/ }));
    expect(onSelect).toHaveBeenCalledWith('t0', 1);
    // A song without a Deezer match has a disabled button.
    expect(screen.getByRole('button', { name: 'No preview of Lemon by Kenshi Yonezu' })).toHaveProperty('disabled', true);
  });

  it('is in the row\'s slot with the rank number, and never inside the row button, so the two are separate buttons', () => {
    const { wrap } = withPlayer();
    draw(wrap, [withId(plastic(), 101)]);
    const play = screen.getByRole('button', { name: 'Play Plastic Love by Mariya Takeuchi' });
    expect(play.parentElement!.closest('button')).toBeNull();
    const slot = play.closest('[data-play-slot]')!;
    expect(slot.querySelector('[data-rank-number]')?.textContent).toBe('1');
  });

  it('shows pause in the slot of the song that is playing, and only there', async () => {
    const { audio, wrap } = withPlayer();
    draw(wrap, [withId(plastic(), 101), withId(lemon(), 102)]);
    fireEvent.click(screen.getByRole('button', { name: 'Play Plastic Love by Mariya Takeuchi' }));
    await act(async () => {
      audio.start();
      await settle();
    });
    expect(screen.getByRole('button', { name: 'Pause Plastic Love by Mariya Takeuchi' }).getAttribute('data-preview')).toBe('playing');
    expect(screen.getByRole('button', { name: 'Play Lemon by Kenshi Yonezu' }).getAttribute('data-preview')).toBe('idle');
  });

  it("shows Deezer's logo above the list when a song on it has a preview, and not otherwise", () => {
    const { wrap } = withPlayer();
    const { unmount } = render(wrap(<SetlistScreen {...setlistProps(RANGE, [withId(plastic(), 101), lemon()], { renderPlay: play })} />));
    expect(screen.getByText('Previews from')).toBeTruthy();
    expect(screen.getByText('Deezer')).toBeTruthy();
    unmount();
    render(wrap(<SetlistScreen {...setlistProps(RANGE, [plastic(), lemon()], { renderPlay: play })} />));
    expect(screen.queryByText('Previews from')).toBeNull();
  });

  it('shows no Deezer line where no play button is offered (the screen was given no renderPlay)', () => {
    render(<SetlistScreen {...setlistProps(RANGE, [withId(plastic(), 101)])} />);
    expect(screen.queryByText('Previews from')).toBeNull();
  });

  it('the Deezer line names Deezer in words beside its logo, and links to the credits, which say the previews are for private listening', () => {
    render(<DeezerCredit />);
    const link = screen.getByRole('link', { name: 'Previews from Deezer, for private listening. Sources and credits' });
    expect(link.getAttribute('href')).toBe('/credits');
    expect(link.textContent).toBe('Previews fromDeezer');
  });
});
