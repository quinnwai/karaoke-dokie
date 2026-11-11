// @vitest-environment jsdom
// Finding 1 of the review of PR #38 (QWW-57): a touch screen on its side and under 500 px tall gets a full-screen "Turn your phone
// upright" over every step. jsdom has no media queries and no layout, so this holds what it can: the words and the icon in the page
// once, the message drawn by Tv beside the TV (so every step has it and none is replaced), and the stylesheet text that shows
// it, so that nobody loosens the query without a test failing. Where the browser shows it, that it covers the viewport and fits,
// and that turning the phone back finds the page as it was, is tests/e2e/landscape.spec.ts.

import { cleanup, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Tv } from '../../src/components/Tv';

afterEach(cleanup);

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
