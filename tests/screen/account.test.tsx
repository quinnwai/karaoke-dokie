// @vitest-environment jsdom
// The Spotify logo at the top right of the results: grey and "Connect to Spotify" without an
// account, green with a "Logged in as ..." box and Log out with one. jsdom applies no CSS, so what
// shows on hover is checked in tests/e2e/screen.spec.ts; here: which control is there, and the
// open/close behaviour that taps and keys drive.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Results } from '../../src/components/Results';
import { resultsProps } from '../helpers/results';
import { match } from '../fixtures/screen';

afterEach(cleanup);

const range = { low: 45, high: 72, source: 'test' as const };
const songs = [match(0), match(1)];

const signedIn = (over: Partial<ReturnType<typeof resultsProps>> = {}) =>
  render(<Results {...resultsProps(range, songs)} {...over} />);
const logo = () => screen.getByRole('button', { name: 'Spotify account' });

describe('Spotify logo without an account', () => {
  it('is the grey Connect to Spotify button and nothing about an account', () => {
    const onConnect = vi.fn();
    render(<Results {...resultsProps(range, songs)} mode="catalogue" displayName={null} onConnect={onConnect} />);
    // The logo up top and the text button under the list.
    const [top] = screen.getAllByRole('button', { name: 'Connect to Spotify' });
    expect(top!.className).not.toMatch(/connectOn/);
    expect(top!.querySelector('svg')).toBeTruthy();
    fireEvent.click(top!);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Spotify account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    expect(screen.queryByText(/Logged in/)).toBeNull();
  });
});

describe('Spotify logo when signed in', () => {
  it('is the green account button, not Connect to Spotify, and says who is signed in', () => {
    signedIn({ displayName: 'Mika Rivera' });
    expect(logo().className).toMatch(/connectOn/);
    expect(logo().querySelector('svg')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect to Spotify' })).toBeNull();
    expect(screen.getByText('Logged in as Mika Rivera')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
  });

  it('opens and closes the box on a tap, and tells assistive tech which it is', () => {
    const { container } = signedIn();
    const wrapper = logo().parentElement!;
    expect(logo().getAttribute('aria-expanded')).toBe('false');
    expect(wrapper.hasAttribute('data-open')).toBe(false);
    expect(logo().getAttribute('aria-controls')).toBe(screen.getByText('Logged in as Test Singer').closest('[id]')!.id);

    fireEvent.click(logo());
    expect(logo().getAttribute('aria-expanded')).toBe('true');
    expect(wrapper.hasAttribute('data-open')).toBe(true);
    fireEvent.click(logo());
    expect(logo().getAttribute('aria-expanded')).toBe('false');
    expect(wrapper.hasAttribute('data-open')).toBe(false);
    // The logo is the only thing that opens it: the rest of the screen is unchanged.
    expect(container.querySelectorAll('[data-open]')).toHaveLength(0);
  });

  it('a tap anywhere else closes it; a tap inside the box does not', () => {
    signedIn();
    fireEvent.click(logo());
    fireEvent.pointerDown(screen.getByText('Logged in as Test Singer'));
    expect(logo().getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(logo());
    expect(logo().getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(logo().getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes it and gives the focus back to the logo', () => {
    signedIn();
    fireEvent.click(logo());
    screen.getByRole('button', { name: 'Log out' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(logo().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(logo());
    // Other keys leave it alone.
    fireEvent.click(logo());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(logo().getAttribute('aria-expanded')).toBe('true');
  });

  it('tapping the logo logs nobody out: that takes Log out', () => {
    const onLogout = vi.fn(async () => {});
    signedIn({ onLogout });
    fireEvent.click(logo());
    expect(onLogout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('shows the button as busy while logging out, and again as usable with a message if it fails', async () => {
    let fail!: (e: Error) => void;
    const onLogout = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    signedIn({ onLogout });
    fireEvent.click(logo());
    const logOut = screen.getByRole('button', { name: 'Log out' }) as HTMLButtonElement;
    fireEvent.click(logOut);
    expect(logOut.disabled).toBe(true);
    // A second tap while it is in flight does nothing.
    fireEvent.click(logOut);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => fail(new Error('offline')));
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t log out. Try again.');
    expect(logOut.disabled).toBe(false);
    // Still signed in, and still the box the failure appeared in.
    expect(screen.getByText('Logged in as Test Singer')).toBeTruthy();
  });
});
