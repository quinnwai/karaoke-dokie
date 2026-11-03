// Song popularity from our own karaoke data (QWW-6), for the songs Spotify gives no popularity for
// (it sends none to Development Mode apps). Two files from the vocal-range pipeline:
//   karafun_songs.csv    the KaraFun catalogue, with the YouTube views of each song's karaoke videos
//   billboard_songs.csv  the Billboard Year-End Hot 100 charts, from 1990
// They are only read here. scripts/popularity-import.ts writes the merged numbers to the
// song_popularity table; nothing from either file belongs in this repository.

import { parseCsv } from '../moods/csv';
import type { SongPopularityRecord } from '../server/store';
import { songKey } from '../songs/resolve';

/** A song's best Year-End chart entry. */
export interface ChartEntry {
  rank: number;
  year: number;
}

/** A file's rows as cells by column name, refusing a file that lacks a column we read. */
function readColumns(text: string, file: string, columns: string[]): Record<string, string>[] {
  const [header = [], ...rows] = parseCsv(text);
  const at = columns.map((c) => {
    const i = header.indexOf(c);
    if (i < 0) throw new Error(`${file} has no ${c} column`);
    return i;
  });
  return rows.map((r) => Object.fromEntries(columns.map((c, j) => [c, (r[at[j]!] ?? '').trim()])));
}

/** A whole number in [min, max], or an error naming the file, row and column. */
function wholeNumber(value: string, where: string, column: string, min: number, max: number): number {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${where}: ${column} "${value}" is not a whole number from ${min} to ${max}`);
  }
  return n;
}

/** True for "artist|title" with both parts present. */
const isSongKey = (key: string) => key.indexOf('|') > 0 && !key.endsWith('|');

/** Karaoke views per song key (app_key, already the app's songKey); the largest when a song is listed twice. */
export function karafunViews(csv: string): Map<string, number> {
  const file = 'karafun_songs.csv';
  const views = new Map<string, number>();
  readColumns(csv, file, ['app_key', 'view_count_total']).forEach((r, i) => {
    const where = `${file} row ${i + 1}`;
    const key = r.app_key!;
    if (!isSongKey(key)) throw new Error(`${where}: app_key "${key}" is not an artist|title key`);
    const n = wholeNumber(r.view_count_total!, where, 'view_count_total', 0, Number.MAX_SAFE_INTEGER);
    views.set(key, Math.max(views.get(key) ?? 0, n));
  });
  return views;
}

/**
 * The first artist a chart credit names: "Mariah Carey and Boyz II Men" -> "Mariah Carey",
 * "The Group: Singer One, Singer Two" -> "The Group", "The Duo (One and Two)" -> "The Duo". A band
 * named with "and" or "&" is cut too ("Hootie & the Blowfish" -> "Hootie"), which only adds a key
 * that no song has.
 */
export function leadArtist(credit: string): string {
  const unbracketed = credit.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  return (unbracketed.split(/\s+(?:featuring|feat\.|ft\.|with|and|&)\s+|\s*[,/]\s*|:\s+/i)[0] ?? '').trim();
}

/**
 * The best Year-End entry per song key: the lowest rank, with that chart's year (the earlier year on
 * a tie). Each row counts under songKey of its credit and title and, when the credit names several
 * artists, under its lead artist's as well. The app knows a duet or feature by its lead artist
 * (Spotify lists "Mariah Carey" first, and the vocal-range pipeline keys its ranges the same way)
 * but a band by its whole name ("Hootie & the Blowfish"), and the credit alone does not say which
 * it is, so the row goes under both.
 */
export function billboardCharts(csv: string): Map<string, ChartEntry> {
  const file = 'billboard_songs.csv';
  const best = new Map<string, ChartEntry>();
  const keep = (key: string, entry: ChartEntry) => {
    const old = best.get(key);
    if (!old || entry.rank < old.rank || (entry.rank === old.rank && entry.year < old.year)) best.set(key, entry);
  };
  readColumns(csv, file, ['year', 'rank', 'title', 'artist_credit']).forEach((r, i) => {
    const where = `${file} row ${i + 1}`;
    const entry = { rank: wholeNumber(r.rank!, where, 'rank', 1, 100), year: wholeNumber(r.year!, where, 'year', 1900, 2100) };
    const key = songKey(r.artist_credit!, r.title!);
    if (!isSongKey(key)) throw new Error(`${where}: no artist_credit or title`);
    keep(key, entry);
    const lead = songKey(leadArtist(r.artist_credit!), r.title!);
    if (lead !== key && isSongKey(lead)) keep(lead, entry);
  });
  return best;
}

/** One record per song key in either file, with the numbers it has, in key order. */
export function mergePopularity(views: Map<string, number>, charts: Map<string, ChartEntry>): SongPopularityRecord[] {
  return [...new Set([...views.keys(), ...charts.keys()])].sort().map((key) => {
    const v = views.get(key);
    const chart = charts.get(key);
    const source = v === undefined ? 'billboard' : chart ? 'karafun+billboard' : 'karafun';
    const record: SongPopularityRecord = { key, source };
    if (v !== undefined) record.karaokeViews = v;
    if (chart) {
      record.chartRank = chart.rank;
      record.chartYear = chart.year;
    }
    return record;
  });
}

export interface PopularitySummary {
  keys: number;
  withViews: number;
  withChart: number;
  /** Keys with both: how well the two files join. */
  withBoth: number;
  /** Nearest-rank percentiles of the karaoke views, one per key; KARAOKE_VIEWS_FULL in score.ts is the 99th. */
  viewPercentiles: { p10: number; p25: number; p50: number; p75: number; p90: number; p99: number; max: number } | null;
}

export function popularitySummary(records: SongPopularityRecord[]): PopularitySummary {
  const views = records.flatMap((r) => (r.karaokeViews === undefined ? [] : [r.karaokeViews])).sort((a, b) => a - b);
  const at = (p: number) => views[Math.max(0, Math.ceil((p * views.length) / 100) - 1)]!;
  return {
    keys: records.length,
    withViews: views.length,
    withChart: records.filter((r) => r.chartRank !== undefined).length,
    withBoth: records.filter((r) => r.karaokeViews !== undefined && r.chartRank !== undefined).length,
    viewPercentiles: views.length
      ? { p10: at(10), p25: at(25), p50: at(50), p75: at(75), p90: at(90), p99: at(99), max: views[views.length - 1]! }
      : null,
  };
}
