// The hand-labelled gold set that mood labels are scored against (QWW-11). Quinn-Wai fills in a
// spreadsheet (data/moods/gold-set-template.csv, y or n per mood); goldFromCsv turns it into the
// JSON the gate report reads, with who labelled it and when.

import { seededOrder } from './gate';
import { parseCsv, toCsv } from './csv';
import type { SongToLabel } from './label';

export interface GoldSong {
  key: string;
  artist: string;
  title: string;
  year?: number;
  upbeat: boolean;
  heartfelt: boolean;
}

export interface GoldSet {
  labelledBy: string;
  /** Date, e.g. "2026-11-05". */
  labelledAt: string;
  songs: GoldSong[];
}

const COLUMNS = ['key', 'artist', 'title', 'year', 'upbeat', 'heartfelt'] as const;

export function goldTemplateCsv(songs: SongToLabel[]): string {
  return toCsv([[...COLUMNS], ...songs.map((s) => [s.key, s.artist, s.title, s.year ?? '', '', ''])]);
}

const YES = new Set(['y', 'yes', '1', 'true']);
const NO = new Set(['n', 'no', '0', 'false']);

/**
 * Reads a filled-in sheet. A row with both mood cells empty was not labelled and is skipped
 * (counted); one cell empty, anything but y or n, or a song listed twice is an error naming the row.
 */
export function goldFromCsv(text: string, by: { labelledBy: string; labelledAt: string }): { gold: GoldSet; skipped: number } {
  const [header = [], ...rows] = parseCsv(text);
  const col = (name: (typeof COLUMNS)[number]) => {
    const i = header.findIndex((h) => h.trim().toLowerCase() === name);
    if (i < 0 && name !== 'year') throw new Error(`The sheet has no "${name}" column`);
    return i;
  };
  const at = { key: col('key'), artist: col('artist'), title: col('title'), year: col('year'), upbeat: col('upbeat'), heartfelt: col('heartfelt') };
  const songs: GoldSong[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  rows.forEach((row, i) => {
    const line = i + 2; // the header is line 1
    const cell = (j: number) => (row[j] ?? '').trim();
    const up = cell(at.upbeat).toLowerCase();
    const heart = cell(at.heartfelt).toLowerCase();
    if (!up && !heart) {
      skipped++;
      return;
    }
    const yesNo = (v: string, mood: string) => {
      if (YES.has(v)) return true;
      if (NO.has(v)) return false;
      throw new Error(`Line ${line}: ${mood} is "${v}"; use y or n (leave both empty to skip a song)`);
    };
    const key = cell(at.key);
    if (!key) throw new Error(`Line ${line}: no key`);
    if (seen.has(key)) throw new Error(`Line ${line}: ${key} is listed twice`);
    seen.add(key);
    const song: GoldSong = { key, artist: cell(at.artist), title: cell(at.title), upbeat: yesNo(up, 'upbeat'), heartfelt: yesNo(heart, 'heartfelt') };
    const year = Number(cell(at.year));
    if (at.year >= 0 && cell(at.year) && Number.isInteger(year)) song.year = year;
    songs.push(song);
  });
  return { gold: { ...by, songs }, skipped };
}

export interface GoldCandidate extends SongToLabel {
  year: number;
  /** Mostly rapped rather than sung (the pipeline's flag), the one style marker the song list has. */
  rap: boolean;
}

/**
 * Picks songs for the gold set: the same number from each decade, and within a decade sung and
 * mostly-rap songs in proportion (at least one rap song where the decade has any). No artist
 * twice. The same seed always gives the same songs, in a shuffled order so the first rows are a
 * fair sample too (the second labeller takes the first 30).
 */
export function pickGoldSongs(candidates: GoldCandidate[], size: number, seed = 'moods-gold-template-v1'): GoldCandidate[] {
  const decades = new Map<number, GoldCandidate[]>();
  for (const c of candidates) {
    const d = Math.floor(c.year / 10) * 10;
    const list = decades.get(d) ?? [];
    list.push(c);
    decades.set(d, list);
  }
  const usedArtists = new Set<string>();
  const artistOf = (c: GoldCandidate) => c.key.split('|')[0] ?? c.key;
  const take = (pool: GoldCandidate[], n: number) => {
    const out: GoldCandidate[] = [];
    for (const c of seededOrder(pool, seed, (s) => s.key)) {
      if (out.length >= n) break;
      if (usedArtists.has(artistOf(c))) continue;
      usedArtists.add(artistOf(c));
      out.push(c);
    }
    return out;
  };
  const sorted = [...decades.keys()].sort((a, b) => a - b);
  const picked: GoldCandidate[] = [];
  sorted.forEach((d, i) => {
    const pool = decades.get(d) ?? [];
    const quota = Math.floor(size / sorted.length) + (i < size % sorted.length ? 1 : 0);
    const rap = pool.filter((c) => c.rap);
    const rapQuota = rap.length ? Math.max(1, Math.round((quota * rap.length) / pool.length)) : 0;
    const rapPicked = take(rap, rapQuota);
    const sungPicked = take(pool.filter((c) => !c.rap), quota - rapPicked.length);
    // A thin stratum is topped up from the rest of the decade.
    const short = quota - rapPicked.length - sungPicked.length;
    picked.push(...rapPicked, ...sungPicked, ...(short > 0 ? take(pool, short) : []));
  });
  return seededOrder(picked, `${seed}|order`, (s) => s.key);
}
