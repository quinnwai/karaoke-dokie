// Beta event log rules: request validation, the forbidden-prop backstop and the EVENTS kill switch.
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_PROPS, isForbiddenProp, withoutForbiddenProps } from '../../src/lib/eventRules';
import { eventsOn, readConfig } from '../../src/lib/server/config';
import { EVENT_CLOCK_SKEW_MS, validateEvents } from '../../src/lib/server/validate';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const AT = '2026-11-03T11:59:58.000Z';
const ANON = '0f8fad5b-d9cb-469f-a165-70867728950e';

const tap = (extra: Record<string, unknown> = {}) => ({ name: 'tap', at: AT, ...extra });
const batch = (events: unknown, anonId: unknown = ANON) => ({ anonId, events });
const errorFor = (body: unknown): string | null => {
  const v = validateEvents(body, NOW);
  return v.ok ? null : v.error;
};
const props = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, i]));

describe('validateEvents', () => {
  it('returns only the known fields, with times in UTC', () => {
    const v = validateEvents(
      {
        anonId: ANON,
        events: [
          { name: 'song_opened', at: '2026-11-03T13:00:00+01:00', props: { sort: 'top', position: 0, maybe: false, mood: null }, extra: 1 },
          { name: 'results_viewed', at: '2026-11-03T11:59:58Z' },
        ],
        extra: 'ignored',
      },
      NOW,
    );
    expect(v).toEqual({
      ok: true,
      value: {
        anonId: ANON,
        events: [
          { name: 'song_opened', at: '2026-11-03T12:00:00.000Z', props: { sort: 'top', position: 0, maybe: false, mood: null } },
          { name: 'results_viewed', at: AT },
        ],
      },
    });
    expect(v.ok && v.value.events[1]).not.toHaveProperty('props');
  });

  it('accepts every limit', () => {
    const edge = [
      batch([tap()], 'a'.repeat(8)),
      batch([tap()], `${'A1-'.repeat(21)}z`),
      batch(Array.from({ length: 50 }, () => tap())),
      batch([tap({ name: 'ab' }), tap({ name: `a${'b_9'.repeat(16)}` })]),
      batch([tap({ props: props(20) }), tap({ props: { [`a${'B_'.repeat(20)}`]: 'x'.repeat(200) } }), tap({ props: {} })]),
      batch([tap({ at: new Date(NOW + EVENT_CLOCK_SKEW_MS).toISOString() }), tap({ at: new Date(NOW - EVENT_CLOCK_SKEW_MS).toISOString() })]),
      batch([tap({ at: '2026-11-03T12:00Z' }), tap({ at: '2026-11-03T12:00:00.123456-05:30' })]),
    ];
    for (const body of edge) expect(errorFor(body)).toBeNull();
  });

  // Each case breaks one rule; the pattern checks that rule is the one reported.
  it.each([
    ['a body that is not an object', [tap()], /^Body/],
    ['a missing anonId', { events: [tap()] }, /^anonId/],
    ['a 7-character anonId', batch([tap()], 'abcdefg'), /^anonId/],
    ['a 65-character anonId', batch([tap()], 'a'.repeat(65)), /^anonId/],
    ['an anonId with an underscore', batch([tap()], 'device_1234'), /^anonId/],
    ['an anonId with a space', batch([tap()], 'device 1234'), /^anonId/],
    ['a number anonId', batch([tap()], 12345678), /^anonId/],
    ['no events', batch([]), /^events must/],
    ['51 events', batch(Array.from({ length: 51 }, () => tap())), /^events must/],
    ['events that are not a list', batch({ 0: tap() }), /^events must/],
    ['an event that is not an object', batch(['tap']), /^events\[0\]: must be an object/],
    ['an uppercase name', batch([tap({ name: 'Song_opened' })]), /^events\[0\]: name/],
    ['a one-letter name', batch([tap({ name: 'a' })]), /^events\[0\]: name/],
    ['a 50-character name', batch([tap({ name: 'a'.repeat(50) })]), /^events\[0\]: name/],
    ['a name starting with a digit', batch([tap({ name: '1tap' })]), /^events\[0\]: name/],
    ['a name with a dash', batch([tap({ name: 'song-opened' })]), /^events\[0\]: name/],
    ['a missing at', batch([{ name: 'tap' }]), /^events\[0\]: at must be an ISO/],
    ['an at without a time zone', batch([tap({ at: '2026-11-03T12:00:00' })]), /^events\[0\]: at must be an ISO/],
    ['a date-only at', batch([tap({ at: '2026-11-03' })]), /^events\[0\]: at must be an ISO/],
    ['an at in another format', batch([tap({ at: 'Tue, 03 Nov 2026 12:00:00 GMT' })]), /^events\[0\]: at must be an ISO/],
    ['an at that is a number', batch([tap({ at: NOW })]), /^events\[0\]: at must be an ISO/],
    ['an at just over 7 days ahead', batch([tap({ at: new Date(NOW + EVENT_CLOCK_SKEW_MS + 1000).toISOString() })]), /within 7 days/],
    ['an at just over 7 days behind', batch([tap({ at: new Date(NOW - EVENT_CLOCK_SKEW_MS - 1000).toISOString() })]), /within 7 days/],
    ['props that are a list', batch([tap({ props: ['top'] })]), /^events\[0\]: props must be an object/],
    ['props that are null', batch([tap({ props: null })]), /^events\[0\]: props must be an object/],
    ['21 props', batch([tap({ props: props(21) })]), /at most 20 keys/],
    ['a prop name with a dash', batch([tap({ props: { 'sort-by': 'top' } })]), /prop names/],
    ['a prop name starting with an underscore', batch([tap({ props: { _sort: 'top' } })]), /prop names/],
    ['a "__proto__" prop, as JSON.parse makes it', batch([tap({ props: JSON.parse('{"__proto__": {"admin": true}}') })]), /prop names/],
    ['a 42-character prop name', batch([tap({ props: { [`a${'b'.repeat(41)}`]: 1 } })]), /prop names/],
    ['an object prop', batch([tap({ props: { view: { sort: 'top' } } })]), /prop view must be/],
    ['a list prop', batch([tap({ props: { picks: [1, 2] } })]), /prop picks must be/],
    ['a 201-character string prop', batch([tap({ props: { note: 'x'.repeat(201) } })]), /prop note must be/],
    ['a NaN prop', batch([tap({ props: { position: NaN } })]), /prop position must be/],
    ['an Infinity prop', batch([tap({ props: { position: Infinity } })]), /prop position must be/],
  ])('rejects %s', (_name, body, rule) => {
    expect(errorFor(body)).toMatch(rule);
  });

  it('says which event is wrong', () => {
    expect(errorFor(batch([tap(), tap({ name: 'Bad' })]))).toMatch(/^events\[1\]: name/);
  });
});

describe('forbidden props', () => {
  it('matches the five names whatever their case or underscores, and nothing else', () => {
    const variants = ['TRACKID', 'trackid', 'track_id', 'Spotify_Id', 'USER_ID', 'display_name', 'DisplayName', 'Email', 'EMAIL'];
    for (const key of [...FORBIDDEN_PROPS, ...variants]) expect(isForbiddenProp(key)).toBe(true);
    for (const key of ['sort', 'position', 'songKey', 'tracks', 'trackIdx', 'emailed', 'user', 'displayed']) {
      expect(isForbiddenProp(key)).toBe(false);
    }
  });

  it('strips them from an event, dropping props when nothing is left', () => {
    const opened = { name: 'song_opened', at: AT, props: { trackId: 'x', sort: 'top', EMAIL: 'a@b.c' } };
    expect(withoutForbiddenProps(opened)).toEqual({ name: 'song_opened', at: AT, props: { sort: 'top' } });
    const onlyForbidden = withoutForbiddenProps({ name: 'song_opened', at: AT, props: { userId: 'u1' } });
    expect(onlyForbidden).toEqual({ name: 'song_opened', at: AT });
    expect(onlyForbidden).not.toHaveProperty('props');
    expect(opened.props).toHaveProperty('trackId'); // the input is left alone
  });
});

describe('EVENTS kill switch', () => {
  const production = { NODE_ENV: 'production', DATABASE_URL: 'postgres://db' };

  it('is on when unset only for a production build with real Spotify and Postgres', () => {
    expect(eventsOn(production)).toBe(true);
    expect(eventsOn({ ...production, NODE_ENV: 'development' })).toBe(false);
    expect(eventsOn({ ...production, NODE_ENV: 'test' })).toBe(false);
    expect(eventsOn({ ...production, SPOTIFY_MOCK: '1' })).toBe(false);
    expect(eventsOn({ ...production, KARAOKE_STORE: 'memory' })).toBe(false);
    expect(eventsOn({ NODE_ENV: 'production' })).toBe(false); // no DATABASE_URL: memory store
    // The e2e run: a production build with mock Spotify and the memory store.
    expect(eventsOn({ NODE_ENV: 'production', SPOTIFY_MOCK: '1', KARAOKE_STORE: 'memory' })).toBe(false);
    expect(eventsOn({})).toBe(false);
  });

  it('follows EVENTS=on or off, treats blank as unset and anything else as off', () => {
    expect(eventsOn({ EVENTS: 'on' })).toBe(true);
    expect(eventsOn({ EVENTS: ' ON ' })).toBe(true);
    expect(eventsOn({ ...production, EVENTS: 'off' })).toBe(false);
    expect(eventsOn({ ...production, EVENTS: '' })).toBe(true);
    expect(eventsOn({ ...production, EVENTS: '  ' })).toBe(true);
    for (const typo of ['1', 'true', 'yes', 'no', 'of']) expect(eventsOn({ ...production, EVENTS: typo })).toBe(false);
  });

  it('is on the server config', () => {
    expect(readConfig({ EVENTS: 'on' }).collectEvents).toBe(true);
    expect(readConfig({}).collectEvents).toBe(false);
  });
});
