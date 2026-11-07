import { describe, expect, it } from 'vitest';
import {
  AB_BATCH_SIZE,
  AB_PROXIES,
  abBatches,
  abMoods,
  abRecords,
  fetchHighLevel,
  highLevelUrl,
  parseHighLevel,
  type AbModels,
  type CachedResponse,
} from '../../src/lib/moods/acousticbrainz';

/** A made-up recording ID: 8-4-4-4-12 hex, numbered. */
const mbid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A high-level document with the given class probabilities (the rest of the models left out). */
function doc(m: AbModels) {
  const model = (cls: string, p: number) => ({ all: { [cls]: p, [`not_${cls}`]: 1 - p }, probability: Math.max(p, 1 - p), value: p >= 0.5 ? cls : `not_${cls}` });
  return {
    highlevel: {
      mood_happy: model('happy', m.happy),
      mood_party: model('party', m.party),
      mood_sad: model('sad', m.sad),
      mood_relaxed: model('relaxed', m.relaxed),
      danceability: { all: { danceable: m.danceable, not_danceable: 1 - m.danceable } },
      gender: { all: { female: 0.5, male: 0.5 } },
    },
    metadata: { tags: {} },
  };
}

const quiet: AbModels = { happy: 0.2, party: 0.1, sad: 0.3, relaxed: 0.4, danceable: 0.3 };

describe('AB_PROXIES', () => {
  it('Upbeat: happy, party or danceable, and not sad; the bars count as reached', () => {
    expect(abMoods({ ...quiet, happy: 0.7 })).toEqual(['upbeat']);
    expect(abMoods({ ...quiet, party: 0.7 })).toEqual(['upbeat']);
    expect(abMoods({ ...quiet, danceable: 0.8 })).toEqual(['upbeat']);
    expect(abMoods({ ...quiet, happy: 0.69, party: 0.69, danceable: 0.79 })).toEqual([]);
    expect(abMoods({ ...quiet, danceable: 1, sad: 0.5 })).not.toContain('upbeat');
  });

  it('Heartfelt: sad, or relaxed and not happy', () => {
    expect(abMoods({ ...quiet, sad: 0.6 })).toEqual(['heartfelt']);
    expect(abMoods({ ...quiet, relaxed: 0.7 })).toEqual(['heartfelt']);
    expect(abMoods({ ...quiet, relaxed: 0.7, happy: 0.5 })).toEqual([]);
    expect(abMoods({ ...quiet, sad: 0.59, relaxed: 0.69 })).toEqual([]);
    // Both at once is possible: a danceable song whose sad model sits between the bars.
    expect(abMoods({ ...quiet, danceable: 0.9, relaxed: 0.8 })).toEqual(['upbeat', 'heartfelt']);
    expect(AB_PROXIES.upbeat.rule).toBe('mood_happy >= 0.7 or mood_party >= 0.7 or danceability >= 0.8, and mood_sad < 0.5');
  });
});

describe('requests', () => {
  it('asks about distinct IDs, lower case and sorted, at most 25 at a time', () => {
    const ids = Array.from({ length: 60 }, (_, i) => mbid(59 - i));
    const batches = abBatches([...ids, mbid(3).toUpperCase(), mbid(7)]);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 10]);
    expect(batches.flat()).toEqual([...ids].sort());
    expect(AB_BATCH_SIZE).toBe(25);
    expect(highLevelUrl([mbid(1), mbid(2)])).toBe(`https://acousticbrainz.org/api/v1/high-level?recording_ids=${mbid(1)};${mbid(2)}`);
  });
});

describe('parseHighLevel', () => {
  it('reads the models from offset 0, leaving out recordings it cannot read in full', () => {
    const { mood_sad: _sad, ...noSad } = doc(quiet).highlevel;
    const body = {
      [mbid(1)]: { '0': doc({ ...quiet, happy: 0.9 }) },
      [mbid(2).toUpperCase()]: { '0': doc(quiet) },
      [mbid(3)]: { '0': { highlevel: noSad } },
      [mbid(4)]: { '1': doc(quiet) },
      mbid_mapping: {},
    };
    const models = parseHighLevel(body);
    expect([...models.keys()]).toEqual([mbid(1), mbid(2)]);
    expect(models.get(mbid(1))).toEqual({ ...quiet, happy: 0.9 });
    expect(parseHighLevel('not json')).toEqual(new Map());
  });
});

describe('abRecords', () => {
  it('gives every song key whose recording AcousticBrainz has a row; alias keys share a recording', () => {
    const models = new Map([
      [mbid(1), { ...quiet, danceable: 0.95 }],
      [mbid(2), quiet],
    ]);
    const rows = abRecords(
      [
        { key: '*band|song', mbid: mbid(1) },
        { key: 'band|song', mbid: mbid(1).toUpperCase() },
        { key: 'other|song', mbid: mbid(2) },
        { key: 'missing|song', mbid: mbid(9) },
        { key: 'other|song', mbid: mbid(1) },
      ],
      models,
    );
    expect(rows).toEqual([
      { key: '*band|song', moods: ['upbeat'], method: 'acousticbrainz-proxy-v1', source: 'acousticbrainz' },
      { key: 'band|song', moods: ['upbeat'], method: 'acousticbrainz-proxy-v1', source: 'acousticbrainz' },
      { key: 'other|song', moods: [], method: 'acousticbrainz-proxy-v1', source: 'acousticbrainz' },
    ]);
  });
});

describe('fetchHighLevel', () => {
  function fakeApi() {
    const urls: string[] = [];
    const headers: unknown[] = [];
    const waits: number[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      urls.push(url);
      headers.push(init.headers);
      const ids = new URL(url).searchParams.get('recording_ids')!.split(';');
      // The API leaves out recordings it does not have: here, every ID ending in 0.
      const body = Object.fromEntries(ids.filter((id) => !id.endsWith('0')).map((id) => [id, { '0': doc(quiet) }]));
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { urls, headers, waits, fetch, sleep: async (ms: number) => void waits.push(ms) };
  }

  it('asks only about recordings no cached response covers, pausing between requests, and saves each response', async () => {
    const api = fakeApi();
    const ids = Array.from({ length: 60 }, (_, i) => mbid(i + 1));
    // The cache already asked about the first 10, and found all but number 10.
    const cached: CachedResponse[] = [{ requested: ids.slice(0, 10), body: Object.fromEntries(ids.slice(0, 9).map((id) => [id, { '0': doc(quiet) }])) }];
    const saved: CachedResponse[] = [];
    const progress: string[] = [];
    const models = await fetchHighLevel({
      mbids: ids,
      cached,
      save: async (r) => void saved.push(r),
      http: { fetch: api.fetch, sleep: api.sleep },
      onBatch: (done, total) => progress.push(`${done}/${total}`),
    });
    expect(api.urls).toHaveLength(2);
    expect(saved.map((s) => s.requested)).toEqual([ids.slice(10, 35), ids.slice(35)]);
    expect(api.waits).toEqual([500]);
    expect(progress).toEqual(['1/2', '2/2']);
    expect(api.headers[0]).toMatchObject({ 'user-agent': expect.stringContaining('karaoke-dokie') });
    // Found: all but the IDs ending in 0 (10, 20, ..., 60).
    expect(models.size).toBe(54);
    expect(models.has(mbid(10))).toBe(false);
  });

  it('makes no request when the cache covers every recording', async () => {
    const api = fakeApi();
    const models = await fetchHighLevel({
      mbids: [mbid(1)],
      cached: [{ requested: [mbid(1), mbid(2)], body: { [mbid(1)]: { '0': doc(quiet) }, [mbid(2)]: { '0': doc(quiet) } } }],
      save: async () => {},
      http: { fetch: api.fetch, sleep: api.sleep },
    });
    expect(api.urls).toEqual([]);
    expect([...models.keys()]).toEqual([mbid(1)]);
  });
});
