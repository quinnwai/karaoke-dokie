// Puts every popularity signal on one scale (QWW-32). Each source counts popularity in its own
// units (USDB views, KaraFun karaoke-video views, Spotify's 0-100), so a hand-made formula per
// source (log views over a chosen "full" number, Spotify / 100) scores a typical song differently
// on each. Here the scale is fixed by data instead:
//   - the anchor is USDB views: a song's score is the share of catalogue songs with USDB views
//     that have fewer (its percentile, 0 to 1);
//   - every other source is linked to the anchor on the songs that have both (equipercentile
//     linking): a value at the q-th quantile of that source, among those songs, scores what the
//     q-th quantile of their anchor scores. So a song typical of the overlap on one source scores
//     what it would on USDB views;
//   - a Billboard Year-End entry is a floor at the lower quartile of the anchored score of the
//     charting songs in its tier (top 20, 21 to 100), the rule CHART_FLOOR followed before.
// USDB stars are left out: in November 2026, 97% of USDB songs had 5 stars and the rest 4.5, and
// stars went slightly down as views went up, so they say nothing about how well known a song is.
// `npm run popularity:calibrate` reads the numbers and writes src/lib/songs/popularityScale.ts.

/** Piecewise-linear map: [value, score] points, value ascending, score non-decreasing. */
export type ScalePoints = [number, number][];

export interface PopularityScale {
  usdbViews: ScalePoints;
  karaokeViews: ScalePoints;
  /** Empty when there was no Spotify popularity to link (Spotify then counts popularity / 100). */
  spotify: ScalePoints;
  chartFloor: { top20: number; top100: number };
}

/** One song's raw popularity numbers, as calibration reads them. */
export interface CalibrationSong {
  usdbViews?: number;
  karaokeViews?: number;
  spotify?: number;
  chartRank?: number;
}

/** Quantiles every 5%: 21 points per source, enough to follow the curve. */
const STEPS = 20;

/** The q-th quantile (0-1) of sorted `xs`, interpolated between neighbours. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) throw new Error('quantile of nothing');
  const at = q * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Score of `x` on `points`; clamped to the first and last score outside them. */
export function onScale(points: ScalePoints, x: number): number {
  if (!points.length) throw new Error('empty scale');
  if (x <= points[0]![0]) return points[0]![1];
  const last = points[points.length - 1]!;
  if (x >= last[0]) return last[1];
  let i = 1;
  while (points[i]![0] < x) i++;
  const [x0, y0] = points[i - 1]!;
  const [x1, y1] = points[i]!;
  return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** Points from paired quantiles; equal values keep their highest score so the map stays a function. */
function pointsFrom(xs: number[], ys: number[]): ScalePoints {
  const sx = [...xs].sort((a, b) => a - b);
  const sy = [...ys].sort((a, b) => a - b);
  const out: ScalePoints = [];
  for (let i = 0; i <= STEPS; i++) {
    const x = round(quantile(sx, i / STEPS), 3);
    const y = round(quantile(sy, i / STEPS), 4);
    const prev = out[out.length - 1];
    if (prev && prev[0] === x) prev[1] = y;
    else out.push([x, y]);
  }
  return out;
}

/** Fewer songs than this in an overlap and a link is not trusted. */
export const MIN_OVERLAP = 50;

export interface CalibrationReport {
  scale: PopularityScale;
  counts: { anchor: number; karaokeViews: number; spotify: number; top20: number; top100: number };
}

/**
 * Builds the scale from the catalogue's songs. Throws when the anchor or a link has fewer than
 * MIN_OVERLAP songs, except Spotify, which is left empty (Spotify no longer sends popularity to
 * Development Mode apps, so there may be none).
 */
export function calibrate(songs: CalibrationSong[]): CalibrationReport {
  const withViews = songs.filter((s) => typeof s.usdbViews === 'number');
  if (withViews.length < MIN_OVERLAP) throw new Error(`Only ${withViews.length} songs have USDB views; run usdb:index first`);
  const views = withViews.map((s) => s.usdbViews!);
  // Anchor: percentile of USDB views. Quantile q of the views scores q.
  const anchorPoints = pointsFrom(views, views.map((_, i) => (views.length === 1 ? 1 : i / (views.length - 1))));
  const anchor = (s: CalibrationSong) => onScale(anchorPoints, s.usdbViews!);

  const link = (key: 'karaokeViews' | 'spotify', optional = false): [ScalePoints, number] => {
    const both = withViews.filter((s) => typeof s[key] === 'number');
    if (both.length < MIN_OVERLAP) {
      if (optional) return [[], both.length];
      throw new Error(`Only ${both.length} songs have both USDB views and ${key}`);
    }
    return [pointsFrom(both.map((s) => s[key]!), both.map(anchor)), both.length];
  };
  const [karaokeViews, nKaraoke] = link('karaokeViews');
  const [spotify, nSpotify] = link('spotify', true);

  // Chart floors: lower quartile of what charting songs score from everything but the chart.
  const scored = (s: CalibrationSong) => {
    const parts: number[] = [];
    if (typeof s.usdbViews === 'number') parts.push(onScale(anchorPoints, s.usdbViews));
    if (typeof s.karaokeViews === 'number') parts.push(onScale(karaokeViews, s.karaokeViews));
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : undefined;
  };
  const floorOf = (inTier: (rank: number) => boolean): [number, number] => {
    const xs = songs
      .filter((s) => typeof s.chartRank === 'number' && inTier(s.chartRank))
      .map(scored)
      .filter((x): x is number => x !== undefined)
      .sort((a, b) => a - b);
    if (xs.length < MIN_OVERLAP) throw new Error(`Only ${xs.length} charting songs to set a floor with`);
    return [round(quantile(xs, 0.25), 2), xs.length];
  };
  const [top20, nTop20] = floorOf((r) => r <= 20);
  const [top100, nTop100] = floorOf((r) => r > 20);

  return {
    scale: { usdbViews: anchorPoints, karaokeViews, spotify, chartFloor: { top20: Math.max(top20, top100), top100 } },
    counts: { anchor: withViews.length, karaokeViews: nKaraoke, spotify: nSpotify, top20: nTop20, top100: nTop100 },
  };
}
