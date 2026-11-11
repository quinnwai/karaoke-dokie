// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Credits from '../../app/credits/page';

afterEach(cleanup);

describe('/credits: the analytics note (QWW-51)', () => {
  it('tells testers what is recorded, and what is not', () => {
    render(<Credits />);
    expect(screen.getByRole('heading', { name: 'Analytics while we test' })).toBeTruthy();
    const note = screen.getByRole('heading', { name: 'Analytics while we test' }).closest('section')!;
    const text = note.textContent!;
    expect(text).toMatch(/record what you tap/);
    expect(text).toMatch(/random number made on your phone/);
    expect(text).toMatch(/never your name, your email or your Spotify account/);
    expect(text).toMatch(/replay of your screen/);
    expect(text).toMatch(/off while you are signed in to Spotify/);
    expect(text).toMatch(/Your voice is worked out on your phone and is never recorded or sent/);
    expect(text).toMatch(/PostHog/);
  });

  it('keeps the sources and credits list', () => {
    render(<Credits />);
    expect(screen.getByRole('heading', { name: 'Sources and credits' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'USDB (UltraStar DataBase)' })).toBeTruthy();
  });
});
