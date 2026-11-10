// @vitest-environment jsdom
// The play button in each song row (QWW-48), alone and in today's rows.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeezerCredit, PreviewButton, PreviewPlayerContext } from '../../src/components/PreviewButton';
import { Results } from '../../src/components/Results';
import type { Match } from '../../src/lib/contracts';
import { createPreviewPlayer, type PreviewCheck } from '../../src/lib/client/preview';
import { FakeAudio, settle } from '../helpers/fakeAudio';
import { resultsProps } from '../helpers/results';
import { match } from '../fixtures/screen';

afterEach(cleanup);

function withPlayer(check: PreviewCheck = async () => 'retry') {
  const audio = new FakeAudio();
  const player = createPreviewPlayer({ makeAudio: () => audio as unknown as HTMLAudioElement, check });
  const wrap = (ui: ReactNode) => <PreviewPlayerContext.Provider value={player}>{ui}</PreviewPlayerContext.Provider>;
  return { audio, player, wrap };
}

const range = { low: 45, high: 72, source: 'test' as const };
const withId = (m: Match, deezerId: number): Match => ({ ...m, deezerId });

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

describe('play button in the result rows', () => {
  it('sits beside each row, plays without opening the song page, and the row still opens it', () => {
    const { audio, wrap } = withPlayer();
    const onSelect = vi.fn();
    render(wrap(<Results {...resultsProps(range, [withId(match(0), 101), match(1)])} onSelect={onSelect} />));

    fireEvent.click(screen.getByRole('button', { name: 'Play Plastic Love by Mariya Takeuchi' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(audio.src).toBe('/api/preview/101');

    fireEvent.click(screen.getByRole('button', { name: /^Plastic Love by Mariya Takeuchi,/ }));
    expect(onSelect).toHaveBeenCalledWith('t0', 1);
    // A song without a Deezer match has a disabled button.
    expect(screen.getByRole('button', { name: 'No preview of Lemon by Kenshi Yonezu' })).toHaveProperty('disabled', true);
  });

  it('is never inside the row button, so the two are separate buttons', () => {
    const { wrap } = withPlayer();
    render(wrap(<Results {...resultsProps(range, [withId(match(0), 101)])} />));
    const play = screen.getByRole('button', { name: 'Play Plastic Love by Mariya Takeuchi' });
    expect(play.parentElement!.closest('button')).toBeNull();
  });

  it("shows Deezer's logo by the list when a song on it has a preview, and not otherwise", () => {
    const { wrap } = withPlayer();
    const { unmount } = render(wrap(<Results {...resultsProps(range, [withId(match(0), 101), match(1)])} />));
    expect(screen.getByText('Previews from')).toBeTruthy();
    expect(screen.getByText('Deezer')).toBeTruthy();
    unmount();
    render(wrap(<Results {...resultsProps(range, [match(0), match(1)])} />));
    expect(screen.queryByText('Previews from')).toBeNull();
  });

  it('the Deezer line names Deezer in words beside its logo, and links to the credits, which say the previews are for private listening', () => {
    render(<DeezerCredit />);
    const link = screen.getByRole('link', { name: 'Previews from Deezer, for private listening. Sources and credits' });
    expect(link.getAttribute('href')).toBe('/credits');
    expect(link.textContent).toBe('Previews fromDeezer');
  });
});
