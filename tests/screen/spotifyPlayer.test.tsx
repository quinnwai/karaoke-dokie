// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotifyPlayer } from '../../src/components/SpotifyPlayer';
import { track } from '../fixtures/screen';

afterEach(cleanup);

const withLink = (spotifyUrl: string) => ({ ...track(0), spotifyUrl });

describe('SpotifyPlayer', () => {
  it("shows Spotify's own player for a track link, and no separate link", () => {
    render(<SpotifyPlayer track={withLink('https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J')} />);

    const frame = screen.getByTitle('Spotify player: Plastic Love by Mariya Takeuchi');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('https://open.spotify.com/embed/track/7tFiyTwD0nx5a1eklYtX2J');
    expect(screen.queryByRole('link', { name: 'Open in Spotify' })).toBeNull();
  });

  it('keeps the attributes Spotify asks for (without encrypted-media it only plays previews)', () => {
    render(<SpotifyPlayer track={withLink('https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J')} />);

    const frame = screen.getByTitle(/^Spotify player/);
    expect(frame.getAttribute('allow')).toBe('autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture');
    expect(frame.getAttribute('loading')).toBe('lazy');
  });

  it('falls back to an Open in Spotify link when the link is not a track to embed (the offline mock)', () => {
    const search = 'https://open.spotify.com/search/Queen%20Bohemian%20Rhapsody';
    render(<SpotifyPlayer track={withLink(search)} />);

    expect(screen.queryByTitle(/^Spotify player/)).toBeNull();
    const link = screen.getByRole('link', { name: 'Open in Spotify' });
    expect(link.getAttribute('href')).toBe(search);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('uses the given label and reports a tap on the fallback link', () => {
    const onOpen = vi.fn();
    render(<SpotifyPlayer track={withLink('https://open.spotify.com/search/Queen')} label="Find on Spotify" onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('link', { name: 'Find on Spotify' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
