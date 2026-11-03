// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SongDetail } from '../../src/components/SongDetail';
import { handleSpotifyClick } from '../../src/lib/client/spotifyLink';
import { match } from '../fixtures/screen';

// The behavior itself is covered in spotifyLink.test.ts; here only that the link is wired to it.
vi.mock('../../src/lib/client/spotifyLink', () => ({
  handleSpotifyClick: vi.fn((e: { preventDefault(): void }) => e.preventDefault()),
}));

afterEach(cleanup);

describe('SongDetail: Open in Spotify', () => {
  it('stays a real web link, and a click goes through the Spotify link handler with that URL', () => {
    render(
      <SongDetail
        match={match(2)}
        userRange={{ low: 45, high: 72, source: 'test' }}
        source={undefined}
        feedback={undefined}
        onFeedback={() => {}}
        onBack={() => {}}
      />,
    );
    const link = screen.getByRole('link', { name: 'Open in Spotify' });
    expect(link.getAttribute('href')).toBe('https://open.spotify.com/track/t2');
    expect(link.getAttribute('target')).toBe('_blank');

    fireEvent.click(link);
    expect(handleSpotifyClick).toHaveBeenCalledOnce();
    expect(vi.mocked(handleSpotifyClick).mock.calls[0]?.[1]).toBe('https://open.spotify.com/track/t2');
  });
});
