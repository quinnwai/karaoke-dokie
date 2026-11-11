// Which mode a phone opens in, and whether the expanded sheet fits (src/lib/setlist/fit.ts; QWW-57, decision 1). The
// numbers are the ones chief-keef measured on the reference on 11 Nov (the table in the ticket), reduced to what the
// browser would report: the list's height and the rack's height in the mode the screen is in.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEEZER_LINE, expandedFit, MIN_OPENING_ROWS, ROW_HEIGHT } from '../../src/lib/setlist/fit';
import { RACK_FULL, RACK_MINI } from '../../src/lib/setlist/sheet';

describe('expandedFit: the phones that were measured', () => {
  // [screen, list height with the sheet expanded, rows, list height with it mini, rows]
  it.each([
    ['390x844 (the spec)', 226, 3, 478, 7],
    ['390x664 (iPhone 13 to 15, Safari)', 46, 0, 298, 4],
    ['412x780 (Android Chrome)', 162, 2, 414, 6],
  ])('%s: expanded leaves %i px (%i rows), mini %i px (%i rows)', (_screen, expanded, expandedRows, mini, miniRows) => {
    const fromExpanded = expandedFit({ list: expanded, rack: RACK_FULL });
    expect(fromExpanded.listHeight).toBe(expanded);
    expect(fromExpanded.rows).toBe(expandedRows);
    // Read from mini the answer is the same: the list and the rack share one room.
    const fromMini = expandedFit({ list: mini, rack: RACK_MINI });
    expect(fromMini.listHeight).toBe(expanded);
    expect(fromMini.rows).toBe(expandedRows);
    expect(Math.floor(mini / ROW_HEIGHT)).toBe(miniRows);
  });

  it('opens expanded on the 390x844 and in mini on every other phone measured', () => {
    expect(expandedFit({ list: 226, rack: RACK_FULL }).opensMini).toBe(false);
    expect(expandedFit({ list: 46, rack: RACK_FULL }).opensMini).toBe(true);
    expect(expandedFit({ list: 162, rack: RACK_FULL }).opensMini).toBe(true);
    expect(expandedFit({ list: 187, rack: RACK_MINI }).opensMini).toBe(true); // 375x553
  });

  it('can expand wherever the sheet fits, even with no row to spare, and not on a 375x553', () => {
    expect(expandedFit({ list: 46, rack: RACK_FULL }).canExpand).toBe(true);
    expect(expandedFit({ list: 0, rack: RACK_FULL }).canExpand).toBe(true);
    // Mini leaves 187 px there, so expanded is 65 px too tall: "cut off by 65 px".
    const se = expandedFit({ list: 187, rack: RACK_MINI });
    expect(se.listHeight).toBe(-65);
    expect(se.canExpand).toBe(false);
    expect(se.rows).toBe(0);
  });
});

describe('expandedFit: the edges', () => {
  it('needs three whole rows, so 197 px opens in mini and 198 px opens expanded', () => {
    expect(MIN_OPENING_ROWS).toBe(3);
    expect(expandedFit({ list: 3 * ROW_HEIGHT - 1, rack: RACK_FULL }).opensMini).toBe(true);
    expect(expandedFit({ list: 3 * ROW_HEIGHT, rack: RACK_FULL }).opensMini).toBe(false);
  });

  it('counts the spill of an expanded sheet that is too tall, which squeezes the list to nothing', () => {
    // Expanded on a 375x553: the list is 0 px and the content runs 65 px past the bottom edge.
    const fit = expandedFit({ list: 0, rack: RACK_FULL, overflow: 65 });
    expect(fit.listHeight).toBe(-65);
    expect(fit.canExpand).toBe(false);
  });

  it('is the same in the middle of a drag, when the rack is between its two heights', () => {
    const rack = 300;
    const list = 226 + (RACK_FULL - rack); // the list gets what the rack gives up
    expect(expandedFit({ list, rack })).toEqual(expandedFit({ list: 226, rack: RACK_FULL }));
  });

  it('never reports negative rows', () => {
    expect(expandedFit({ list: 0, rack: RACK_MINI }).rows).toBe(0);
  });
});

describe('expandedFit: what stands over the first row (Deezer\'s credit line, a note about Spotify)', () => {
  it('counts only the rows below it: 3 rows need 198 px plus what is above them', () => {
    // 22 px of credit line over a list that would show 3 whole rows: the third no longer fits, so the sheet opens mini.
    expect(expandedFit({ list: 3 * ROW_HEIGHT, rack: RACK_FULL, above: 22 }).rows).toBe(2);
    expect(expandedFit({ list: 3 * ROW_HEIGHT, rack: RACK_FULL, above: 22 }).opensMini).toBe(true);
    expect(expandedFit({ list: 3 * ROW_HEIGHT + 22, rack: RACK_FULL, above: 22 }).opensMini).toBe(false);
  });

  it('keeps the 390x844 expanded with the credit line over its list: 226 px less 22 leaves 3 whole rows', () => {
    expect(expandedFit({ list: 226, rack: RACK_FULL, above: 22 })).toMatchObject({ rows: 3, opensMini: false });
  });

  it('is nothing when nothing is above the rows, as before', () => {
    expect(expandedFit({ list: 226, rack: RACK_FULL, above: 0 })).toEqual(expandedFit({ list: 226, rack: RACK_FULL }));
  });

  it('does not change whether the sheet fits the screen, only the rows', () => {
    const fit = expandedFit({ list: 10, rack: RACK_FULL, above: 22 });
    expect(fit.canExpand).toBe(true);
    expect(fit.listHeight).toBe(10);
    expect(fit.rows).toBe(0);
  });

  it('never reports negative rows', () => {
    expect(expandedFit({ list: 20, rack: RACK_FULL, above: 100 }).rows).toBe(0);
  });
});

describe('DEEZER_LINE: the line over the first row that the fit reserves before the rows are there', () => {
  it('is the height the stylesheet gives it: 2 px above, a 16 px line, 4 px below', () => {
    const css = readFileSync('src/components/setlist/rows.module.css', 'utf8');
    const block = /p\.deezer\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/padding:\s*2px 0 4px;/);
    expect(block).toMatch(/line-height:\s*16px;/);
    expect(block).toMatch(/margin:\s*0;/);
    expect(DEEZER_LINE).toBe(2 + 16 + 4);
  });

  it('leaves the 390x844 expanded and sends a screen 14 px shorter to mini', () => {
    expect(expandedFit({ list: 226, rack: RACK_FULL, above: DEEZER_LINE }).opensMini).toBe(false);
    expect(expandedFit({ list: 212, rack: RACK_FULL, above: DEEZER_LINE }).opensMini).toBe(true);
  });
});
