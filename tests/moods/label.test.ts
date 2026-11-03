import { describe, expect, it } from 'vitest';
import type { Ask, AskRequest } from '../../src/lib/moods/ask';
import {
  addBatch,
  formatLabelRun,
  labelRequest,
  LABELS_SCHEMA,
  labelSongs,
  newLabelRun,
  parseLabelRun,
  parseLabels,
  songsToLabel,
  SYSTEM_PROMPT,
  toMoodRecords,
  type BatchResult,
  type MoodLabel,
  type SongToLabel,
} from '../../src/lib/moods/label';

const song = (n: number, over: Partial<SongToLabel> = {}): SongToLabel => ({ key: `artist ${n}|song ${n}`, artist: `Artist ${n}`, title: `Song ${n}`, ...over });
const label = (key: string, over: Partial<MoodLabel> = {}): MoodLabel => ({ key, known: true, upbeat: false, heartfelt: false, ...over });

describe('labelRequest', () => {
  it('sends the instructions, then one JSON line per song with what we know about it', () => {
    const req = labelRequest(
      [song(1, { year: 1999, genre: 'Pop' }), { key: 'p!nk|so what', artist: 'P!nk', title: 'So What', year: 2008 }, song(3)],
      'claude-haiku-5-5',
    );
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.system).toBe(SYSTEM_PROMPT);
    expect(req.schema).toBe(LABELS_SCHEMA);
    const [intro, ...lines] = req.user.split('\n');
    expect(intro).toBe('Label these 3 songs:');
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { key: 'artist 1|song 1', artist: 'Artist 1', title: 'Song 1', year: 1999, genre: 'Pop' },
      { key: 'p!nk|so what', artist: 'P!nk', title: 'So What', year: 2008 },
      { key: 'artist 3|song 3', artist: 'Artist 3', title: 'Song 3' },
    ]);
  });

  it('defines both moods, lets the model say it does not know a song, and asks for the strict shape', () => {
    expect(SYSTEM_PROMPT).toContain('- upbeat: energetic, happy and danceable');
    expect(SYSTEM_PROMPT).toContain('- heartfelt: love, heartbreak or a ballad');
    expect(SYSTEM_PROMPT).toContain('set "known" to false');
    expect(LABELS_SCHEMA.properties.labels.items.required).toEqual(['key', 'known', 'upbeat', 'heartfelt']);
    expect(LABELS_SCHEMA.properties.labels.items.additionalProperties).toBe(false);
  });
});

describe('parseLabels', () => {
  const keys = ['a|1', 'a|2', 'a|3', 'a|4'];

  it('keeps well-formed labels for songs in the batch; songs left out are just not labelled', () => {
    const text = JSON.stringify({ labels: [label('a|1', { upbeat: true }), label('a|3', { known: false })] });
    expect(parseLabels(text, keys)).toEqual({ labels: [label('a|1', { upbeat: true }), label('a|3', { known: false })], dropped: 0 });
  });

  it('drops and counts malformed items, keys not in the batch, and every copy of a repeated key', () => {
    const text = JSON.stringify({
      labels: [
        label('a|1', { heartfelt: true }),
        { key: 'a|2', known: 'yes', upbeat: false, heartfelt: false },
        { key: 'a|3', known: true, upbeat: false },
        { ...label('a|4'), attitude: true },
        label('a|99'),
        label('A|1'),
        'a|2',
        label('a|2', { upbeat: true }),
        label('a|2', { upbeat: false }),
      ],
    });
    expect(parseLabels(text, keys)).toEqual({ labels: [label('a|1', { heartfelt: true })], dropped: 8 });
  });

  it('drops the whole batch when the reply is not JSON of the expected shape', () => {
    for (const text of ['', 'Sure! Here are the labels:', '```json\n{"labels": []}\n```', '[]', '{"labels": {}}', JSON.stringify({ labels: [label('a|1')], note: 'hi' })]) {
      expect(parseLabels(text, keys)).toEqual({ labels: [], dropped: 4 });
    }
  });
});

describe('toMoodRecords', () => {
  it("gives a row to each song the model knew, moods in chip order, under the provider's source, and none to unknown songs", () => {
    const labels = [
      label('a|both', { upbeat: true, heartfelt: true }),
      label('a|none'),
      label('a|heart', { heartfelt: true }),
      label('a|unknown', { known: false, upbeat: true }),
    ];
    expect(toMoodRecords(labels, 'claude-haiku-5-5', 'claude')).toEqual([
      { key: 'a|both', moods: ['upbeat', 'heartfelt'], method: 'claude-haiku-5-5/moods-v1', source: 'claude' },
      { key: 'a|none', moods: [], method: 'claude-haiku-5-5/moods-v1', source: 'claude' },
      { key: 'a|heart', moods: ['heartfelt'], method: 'claude-haiku-5-5/moods-v1', source: 'claude' },
    ]);
  });
});

describe('songsToLabel', () => {
  it('reads a song list or a gold set, keeping only what the model may see', () => {
    expect(songsToLabel([{ key: 'a|1', artist: 'A', title: '1', year: 1990, genre: ' Rock ', extra: 'x' }])).toEqual([
      { key: 'a|1', artist: 'A', title: '1', year: 1990, genre: 'Rock' },
    ]);
    const gold = { labelledBy: 'Quinn-Wai', labelledAt: '2026-11-05', songs: [{ key: 'a|1', artist: 'A', title: '1', year: 1990, upbeat: true, heartfelt: false }] };
    expect(songsToLabel(gold)).toEqual([{ key: 'a|1', artist: 'A', title: '1', year: 1990 }]);
  });

  it('refuses songs without a key, artist or title', () => {
    expect(() => songsToLabel([{ key: 'a|1', artist: 'A' }])).toThrow('Song 1 needs a key, an artist and a title');
    expect(() => songsToLabel({ ranges: [] })).toThrow('Expected a list of songs');
  });
});

describe('labels file', () => {
  it('round-trips, one label per line', () => {
    const batch: BatchResult = { labels: [label('a|1', { upbeat: true }), label('a|2', { known: false })], dropped: 1, inputTokens: 900, outputTokens: 300, stopReason: 'end_turn' };
    const run = addBatch(addBatch(newLabelRun('claude-haiku-5-5'), batch), { ...batch, labels: [label('a|3')], dropped: 0 });
    expect(run).toMatchObject({ model: 'claude-haiku-5-5', method: 'claude-haiku-5-5/moods-v1', calls: 2, inputTokens: 1800, outputTokens: 600, dropped: 1 });
    const text = formatLabelRun(run);
    expect(parseLabelRun(text)).toEqual(run);
    expect(text).toContain('\n    {"key":"a|1","known":true,"upbeat":true,"heartfelt":false},\n');
    expect(parseLabelRun(formatLabelRun(newLabelRun('m')))).toEqual(newLabelRun('m'));
  });

  it('records the provider; a file from before providers came from Claude', () => {
    const run = newLabelRun('gpt-6-luna', 'openai');
    expect(run).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', method: 'gpt-6-luna/moods-v1' });
    expect(parseLabelRun(formatLabelRun(run)).provider).toBe('openai');
    const { provider: _provider, ...old } = newLabelRun('claude-haiku-5-5');
    expect(parseLabelRun(JSON.stringify(old)).provider).toBe('anthropic');
    expect(() => parseLabelRun(JSON.stringify({ ...run, provider: 'mistral' }))).toThrow('unknown provider mistral');
  });

  it('refuses files that are not a labels file', () => {
    expect(() => parseLabelRun('[]')).toThrow('Not a labels file');
    expect(() => parseLabelRun(JSON.stringify({ ...newLabelRun('m'), labels: [{ key: 'a|1', known: 'yes' }] }))).toThrow('bad labels');
  });
});

/** A model stand-in: labels every song in the request as known and upbeat, except keys it is told to skip. */
function fakeAsk(skip: string[] = []) {
  const requests: AskRequest[] = [];
  const ask: Ask = async (req) => {
    requests.push(req);
    const keys = req.user.split('\n').slice(1).map((l) => (JSON.parse(l) as SongToLabel).key);
    const labels = keys.filter((k) => !skip.includes(k)).map((k) => label(k, { upbeat: true }));
    return { text: JSON.stringify({ labels }), inputTokens: 100, outputTokens: 10 * labels.length, stopReason: 'end_turn' };
  };
  return { ask, requests };
}

describe('labelSongs', () => {
  const songs = Array.from({ length: 60 }, (_, i) => song(i));

  it('asks in batches of 25, in input order, and hands over each batch as it comes', async () => {
    const { ask, requests } = fakeAsk(['artist 30|song 30']);
    const batches: BatchResult[] = [];
    const summary = await labelSongs({ songs, model: 'claude-haiku-5-5', ask, onBatch: (b) => void batches.push(b) });
    expect(requests.map((r) => r.user.split('\n').length - 1)).toEqual([25, 25, 10]);
    expect(requests[1]!.user).toContain('"key":"artist 25|song 25"');
    expect(batches.map((b) => b.labels.length)).toEqual([25, 24, 10]);
    expect(batches[1]).toMatchObject({ dropped: 0, inputTokens: 100, outputTokens: 240, stopReason: 'end_turn' });
    expect(summary).toEqual({ asked: 60, labelled: 59 });
  });

  it('skips songs already labelled and repeated keys, so a rerun carries on', async () => {
    let run = newLabelRun('claude-haiku-5-5');
    const first = fakeAsk(['artist 3|song 3']);
    await labelSongs({ songs: songs.slice(0, 10), model: run.model, ask: first.ask, onBatch: (b) => void (run = addBatch(run, b)) });
    expect(run.labels).toHaveLength(9);

    const second = fakeAsk();
    const summary = await labelSongs({
      songs: [...songs, song(5)],
      model: run.model,
      ask: second.ask,
      done: new Set(run.labels.map((l) => l.key)),
      onBatch: (b) => void (run = addBatch(run, b)),
    });
    expect(summary).toEqual({ asked: 51, labelled: 51 });
    expect(second.requests[0]!.user.split('\n')[1]).toBe(JSON.stringify(song(3)));
    expect(new Set(run.labels.map((l) => l.key)).size).toBe(60);
    expect(run.calls).toBe(4);
  });

  it('stops on an error from the model call, keeping the batches already handed over', async () => {
    const { ask: good } = fakeAsk();
    let calls = 0;
    const ask: Ask = async (req) => {
      if (++calls === 2) throw new Error('Claude API 401 after 1 try: invalid x-api-key');
      return good(req);
    };
    const kept: MoodLabel[] = [];
    await expect(labelSongs({ songs, model: 'm', ask, onBatch: (b) => void kept.push(...b.labels) })).rejects.toThrow('401');
    expect(kept).toHaveLength(25);
  });
});
