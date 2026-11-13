// @vitest-environment jsdom
// Finding 1 of the review of PR #38 (QWW-57): a touch screen on its side and under 500 px tall gets a full-screen "Turn your phone
// upright" over every step. jsdom has no media queries and no layout, so this holds what it can: the words and the icon in the page
// once, the message drawn by Tv beside the TV (so every step has it and none is replaced), and the stylesheet text that shows
// it, so that nobody loosens the query without a test failing. Where the browser shows it, that it covers the viewport and fits,
// and that turning the phone back finds the page as it was, is tests/e2e/landscape.spec.ts.

import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tv } from '../../src/components/Tv';
import { isSideways, ROTATE_QUERY, useSideways } from '../../src/lib/client/useSideways';
import { phone, unphone } from '../helpers/phone';

afterEach(() => {
  cleanup();
  unphone();
});

const WORDS = 'Turn your phone upright';

describe('the message in the page', () => {
  it('has the words once, in a modal dialog they name, and a decorative icon', () => {
    render(
      <Tv>
        <p>a step</p>
      </Tv>,
    );
    expect(screen.getAllByText(WORDS)).toHaveLength(1);
    const dialog = screen.getByRole('dialog', { name: WORDS });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Nothing else in it: the words and the icon.
    expect(dialog.textContent).toBe(WORDS);
    const icons = dialog.querySelectorAll('svg');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(icons[0]?.getAttribute('focusable')).toBe('false');
  });

  it('is drawn by Tv beside the TV, not around the step: the step stays where it was, and the message is the same node on every step', () => {
    const { rerender } = render(
      <Tv>
        <button type="button">Start</button>
      </Tv>,
    );
    const tv = screen.getByRole('region', { name: 'Karaoke screen' });
    const dialog = screen.getByRole('dialog', { name: WORDS });
    const start = screen.getByRole('button', { name: 'Start' });
    expect(tv.contains(start)).toBe(true);
    expect(tv.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(tv.parentElement);

    // The next step: a different child in the same Tv. Neither the TV nor the message is made again, so a covered page keeps
    // what it has, and a step that appears while the phone is on its side is covered too.
    rerender(
      <Tv>
        <input aria-label="a field" />
      </Tv>,
    );
    expect(screen.getByRole('region', { name: 'Karaoke screen' })).toBe(tv);
    expect(screen.getByRole('dialog', { name: WORDS })).toBe(dialog);
    expect(screen.getAllByText(WORDS)).toHaveLength(1);
    expect(tv.contains(screen.getByLabelText('a field'))).toBe(true);
  });
});

// ---- the stylesheet ----

/** The top-level rules and at-rule blocks of some CSS, as [prelude, body] (comments dropped). A block's body is itself CSS. */
function blocks(text: string): [string, string][] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: [string, string][] = [];
  let depth = 0;
  let from = 0;
  let prelude = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) {
        prelude = css.slice(from, i).trim();
        from = i + 1;
      }
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) {
        found.push([prelude, css.slice(from, i)]);
        from = i + 1;
      }
    }
  }
  return found;
}

const SRC = join(__dirname, '../../src');
const SCREEN_CSS = readFileSync(join(SRC, 'components/screen.module.css'), 'utf8');
const zIndexes = (css: string) => [...css.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1]));
const decl = (body: string, property: string) => new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim();

describe('the stylesheet that shows it', () => {
  const top = blocks(SCREEN_CSS);
  const base = top.filter(([prelude]) => prelude === '.rotateNotice');
  const queries = top.filter(([prelude, body]) => prelude.startsWith('@media') && blocks(body).some(([inner]) => inner === '.rotateNotice'));

  it('hides it unless the one media query below matches, so it is not in the accessibility tree either', () => {
    expect(base).toHaveLength(1);
    expect(decl(base[0]![1], 'display')).toBe('none');
    // No other rule outside a media query sets its display.
    const outside = top.filter(([prelude]) => !prelude.startsWith('@')).flatMap(([prelude, body]) => (prelude.split(',').some((s) => /\.rotateNotice\b/.test(s)) ? [body] : []));
    expect(outside.map((body) => decl(body, 'display')).filter((d) => d !== undefined)).toEqual(['none']);
  });

  it('shows it only for a touch screen (hover: none, pointer: coarse) in landscape under 500 px tall', () => {
    expect(queries).toHaveLength(1);
    const [prelude, body] = queries[0]!;
    const conditions = prelude
      .replace(/^@media\s+/, '')
      .split(/\s+and\s+/)
      .map((c) => c.trim())
      .sort();
    expect(conditions).toEqual(['(hover: none)', '(max-height: 500px)', '(orientation: landscape)', '(pointer: coarse)']);
    // The same query, asked from script (useSideways) to make the page under the message inert: one text for both, or the message would
    // cover a page that is still usable, or lock one that is not covered.
    expect(
      ROTATE_QUERY.split(/\s+and\s+/)
        .map((c) => c.trim())
        .sort(),
    ).toEqual(conditions);
    const inner = blocks(body).filter(([p]) => p === '.rotateNotice');
    expect(inner).toHaveLength(1);
    expect(decl(inner[0]![1], 'display')).toBe('flex');
  });

  it('covers the whole viewport, above every other layer of the page, and takes no pan or pull to refresh', () => {
    const rule = base[0]![1];
    expect(decl(rule, 'position')).toBe('fixed');
    expect(decl(rule, 'inset')).toBe('0');
    expect(decl(rule, 'touch-action')).toBe('none');
    // The account box and its tip are 2, the sheet's parts 1: its own is above all of them, and every other layer in the page's CSS.
    const own = Number(decl(rule, 'z-index'));
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.css'));
    expect(files).toContain(join('components', 'setlist', 'sheet.module.css'));
    const everyLayer = files.flatMap((f) => zIndexes(readFileSync(join(SRC, f), 'utf8')));
    expect(own).toBeGreaterThan(2);
    expect(everyLayer.filter((z) => z >= own)).toEqual([own]);
  });
});

// ---- the page under it ----

describe('useSideways', () => {
  it('is false where nobody can be asked (no media queries, as on a server and in jsdom)', () => {
    expect(isSideways()).toBe(false);
    expect(renderHook(() => useSideways()).result.current).toBe(false);
  });

  it('follows the phone as it is turned, asks the one query, and lets go of it when the page goes', () => {
    const turned = phone();
    const ask = vi.spyOn(window, 'matchMedia');
    const { result, unmount } = renderHook(() => useSideways());
    expect(result.current).toBe(false);
    expect(ask.mock.calls.every(([q]) => q === ROTATE_QUERY)).toBe(true);
    expect(turned.listeners.size).toBe(1);
    turned.turn(true);
    expect(result.current).toBe(true);
    expect(isSideways()).toBe(true);
    turned.turn(false);
    expect(result.current).toBe(false);
    unmount();
    expect(turned.listeners.size).toBe(0);
  });

  it('is true from the first render of a page opened on its side', () => {
    phone(true);
    expect(renderHook(() => useSideways()).result.current).toBe(true);
  });
});

describe('with the phone on its side, the page under the message is not usable (a second pass at finding 1)', () => {
  const tvOf = () => screen.getByRole('region', { name: 'Karaoke screen', hidden: true });
  const dialogOf = () => screen.getByRole('dialog', { name: WORDS });
  const draw = () =>
    render(
      <Tv>
        <button type="button">Start</button>
        <input type="range" aria-label="Tempo" />
      </Tv>,
    );

  it('upright: the TV is not inert and the message has no focus', () => {
    phone();
    draw();
    expect(tvOf().hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('on its side from the start: the TV is inert and the message has the focus, as a dialog does', () => {
    phone(true);
    draw();
    expect(tvOf().hasAttribute('inert')).toBe(true);
    expect(dialogOf().tabIndex).toBe(-1);
    expect(document.activeElement).toBe(dialogOf());
    // The message is not inside what is inert, or it would be inert too.
    expect(tvOf().contains(dialogOf())).toBe(false);
  });

  it('turned to its side with a control focused: the TV goes inert, the focus goes to the message, and turned back it returns to the control', () => {
    const turned = phone();
    draw();
    const slider = screen.getByRole('slider', { name: 'Tempo' });
    slider.focus();
    expect(document.activeElement).toBe(slider);

    turned.turn(true);
    expect(tvOf().hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(dialogOf());

    turned.turn(false);
    expect(tvOf().hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(slider);
  });

  it('turned to its side and back with nothing focused: nothing is focused afterwards either', () => {
    const turned = phone();
    draw();
    turned.turn(true);
    expect(document.activeElement).toBe(dialogOf());
    turned.turn(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('does not take the focus back from where the singer put it since, nor from a control that is gone', () => {
    const turned = phone();
    const { rerender } = draw();
    const outside = document.body.appendChild(document.createElement('input'));
    screen.getByRole('button', { name: 'Start' }).focus();
    turned.turn(true);
    outside.focus();
    turned.turn(false);
    expect(document.activeElement).toBe(outside);

    turned.turn(true);
    screen.getByRole('button', { name: 'Start', hidden: true });
    rerender(
      <Tv>
        <p>the next step</p>
      </Tv>,
    );
    expect(() => turned.turn(false)).not.toThrow();
    outside.remove();
  });

  it('is turned again and again: each turn puts the same things back', () => {
    const turned = phone();
    draw();
    const start = screen.getByRole('button', { name: 'Start' });
    for (let i = 0; i < 3; i++) {
      start.focus();
      turned.turn(true);
      expect(tvOf().hasAttribute('inert')).toBe(true);
      expect(document.activeElement).toBe(dialogOf());
      turned.turn(false);
      expect(tvOf().hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(start);
    }
  });
});
