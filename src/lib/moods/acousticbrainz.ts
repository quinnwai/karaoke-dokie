// AcousticBrainz as a mood source (QWW-19). AcousticBrainz (MetaBrainz, 2015 to 2022, now
// read-only) ran Essentia's audio classifiers on recordings people submitted, and publishes the
// results under CC0, keyed by MusicBrainz recording ID. The vocal-range pipeline's measured
// recordings carry that ID (range.mbid), so their high-level models can be read directly: each is
// a probability from 0 to 1. Two proxy rules turn five of them into the chips; they were fixed in
// data/moods/README.md before AcousticBrainz was compared with MGPHot or any other labels. Being
// CC0, the labels may be committed; the raw responses are cached outside the repo.

import { MOODS, type Mood } from '../contracts';
import type { SongMoodsRecord } from '../server/store';
import { fetchWithRetries, type HttpDeps } from './ask';

export const AB_HIGH_LEVEL_URL = 'https://acousticbrainz.org/api/v1/high-level';
/** The API refuses more than 25 recordings per request. */
export const AB_BATCH_SIZE = 25;
/** At most 2 requests a second: the API allows 100 per 10 s, and is run by volunteers. */
export const AB_PAUSE_MS = 500;
export const AB_METHOD = 'acousticbrainz-proxy-v1';
export const AB_SOURCE = 'acousticbrainz';
const USER_AGENT = 'karaoke-dokie mood labels (https://github.com/quinnwai/karaoke-dokie)';

/** The classifier outputs the rules read: the probability of one class of each model. */
export interface AbModels {
  happy: number;
  party: number;
  sad: number;
  relaxed: number;
  danceable: number;
}

/** Where each output is in a high-level document: highlevel[model].all[class]. */
const READ: Record<keyof AbModels, [model: string, cls: string]> = {
  happy: ['mood_happy', 'happy'],
  party: ['mood_party', 'party'],
  sad: ['mood_sad', 'sad'],
  relaxed: ['mood_relaxed', 'relaxed'],
  danceable: ['danceability', 'danceable'],
};

export const AB_PROXIES: Record<Mood, { rule: string; test: (m: AbModels) => boolean }> = {
  upbeat: {
    rule: 'mood_happy >= 0.7 or mood_party >= 0.7 or danceability >= 0.8, and mood_sad < 0.5',
    test: (m) => (m.happy >= 0.7 || m.party >= 0.7 || m.danceable >= 0.8) && m.sad < 0.5,
  },
  heartfelt: {
    rule: 'mood_sad >= 0.6, or mood_relaxed >= 0.7 and mood_happy < 0.5',
    test: (m) => m.sad >= 0.6 || (m.relaxed >= 0.7 && m.happy < 0.5),
  },
};

export const abMoods = (m: AbModels): Mood[] => MOODS.filter((mood) => AB_PROXIES[mood].test(m));

/** Distinct recording IDs, lower case and sorted, in batches the API accepts. */
export function abBatches(mbids: Iterable<string>, size = AB_BATCH_SIZE): string[][] {
  const ids = [...new Set([...mbids].map((m) => m.toLowerCase()))].sort();
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export const highLevelUrl = (mbids: readonly string[]): string => `${AB_HIGH_LEVEL_URL}?recording_ids=${mbids.join(';')}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The models per recording in one bulk response, {"<mbid>": {"0": {"highlevel": {...}}}, ...}.
 * Recordings AcousticBrainz does not have are absent from it. A recording with several
 * submissions comes back with the first (offset 0), the one the request asks for by default. A
 * document without every model the rules read is left out rather than read as "no".
 */
export function parseHighLevel(body: unknown): Map<string, AbModels> {
  const out = new Map<string, AbModels>();
  if (!isRecord(body)) return out;
  for (const [mbid, offsets] of Object.entries(body)) {
    if (mbid === 'mbid_mapping' || !isRecord(offsets)) continue;
    const doc = offsets['0'];
    const highlevel = isRecord(doc) && isRecord(doc.highlevel) ? doc.highlevel : null;
    if (!highlevel) continue;
    const models = {} as AbModels;
    let complete = true;
    for (const [name, [model, cls]] of Object.entries(READ) as [keyof AbModels, [string, string]][]) {
      const m = highlevel[model];
      const p = isRecord(m) && isRecord(m.all) ? m.all[cls] : undefined;
      if (typeof p !== 'number' || !Number.isFinite(p)) complete = false;
      else models[name] = p;
    }
    if (complete) out.set(mbid.toLowerCase(), models);
  }
  return out;
}

/** Store rows for the songs whose recording AcousticBrainz has: one per key (the first wins), moods possibly none. */
export function abRecords(songs: readonly { key: string; mbid: string }[], models: ReadonlyMap<string, AbModels>): SongMoodsRecord[] {
  const rows = new Map<string, SongMoodsRecord>();
  for (const s of songs) {
    const m = models.get(s.mbid.toLowerCase());
    if (m && !rows.has(s.key)) rows.set(s.key, { key: s.key, moods: abMoods(m), method: AB_METHOD, source: AB_SOURCE });
  }
  return [...rows.values()];
}

/** One raw response as cached: the recordings asked for (found or not) and the body as it came. */
export interface CachedResponse {
  requested: string[];
  body: unknown;
}

/**
 * The models for the recordings, asking the API only about those no cached response asked
 * about, a batch at a time, pausing between requests, and caching each raw response as it comes
 * so a stopped fetch loses nothing. Errors (after fetchWithRetries' retries) stop the fetch.
 */
export async function fetchHighLevel({
  mbids,
  cached,
  save,
  http = {},
  pauseMs = AB_PAUSE_MS,
  onBatch,
}: {
  mbids: Iterable<string>;
  cached: readonly CachedResponse[];
  save: (response: CachedResponse) => Promise<void>;
  http?: HttpDeps;
  pauseMs?: number;
  onBatch?: (done: number, total: number) => void;
}): Promise<Map<string, AbModels>> {
  const sleep = http.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const wanted = new Set([...mbids].map((m) => m.toLowerCase()));
  const asked = new Set(cached.flatMap((c) => c.requested));
  const batches = abBatches([...wanted].filter((m) => !asked.has(m)));
  const responses = [...cached];
  for (const [i, batch] of batches.entries()) {
    if (i > 0) await sleep(pauseMs);
    const res = await fetchWithRetries('AcousticBrainz', highLevelUrl(batch), { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, http);
    const response = { requested: batch, body: await res.json() };
    await save(response);
    responses.push(response);
    onBatch?.(i + 1, batches.length);
  }
  const out = new Map<string, AbModels>();
  for (const r of responses) {
    for (const [mbid, models] of parseHighLevel(r.body)) if (wanted.has(mbid)) out.set(mbid, models);
  }
  return out;
}
