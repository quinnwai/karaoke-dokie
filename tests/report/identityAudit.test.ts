import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { identityAudit, identityAuditCsv, identityAuditText } from '../../src/lib/report/identityAudit';
import { createMockSpotifyClient, MOCK_TRACKS } from '../../src/lib/server/mockSpotify';
import { getUserTracks } from '../../src/lib/server/spotify';
import type { SongRangeRecord, UsdbIndexEntry } from '../../src/lib/server/store';

// A small library with every kind of case the audit lists. Invented ids and ISRCs.
let rank = 0;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
function listing(title: string, artists: string | string[], seconds: number, isrc: string): Track {
  const names = Array.isArray(artists) ? artists : [artists];
  const credited = names.map((name) => ({ id: `artist-${slug(name)}`, name }));
  const playRank = rank++;
  return { id: `track-${playRank}`, title, artist: names[0]!, artistId: credited[0]!.id, spotifyUrl: '', playRank, artists: credited, durationMs: Math.round(seconds * 1000), isrc };
}
const posner = 'Mike Posner';
const library = (): Track[] => {
  rank = 0;
  return [
    listing('Burning Blue', 'Mariah the Scientist', 206, 'ISRC-BB'),
    listing('Burning Blue', 'Mariah the Scientist', 206, 'ISRC-BB'),
    listing('Burning Blue', 'Mariah the Scientist', 206, 'ISRC-BB'),
    listing('Cooler Than Me - Single Mix', [posner, 'Gigamesh'], 213, 'ISRC-SM'),
    listing('Cooler Than Me - Single Mix', [posner, 'Gigamesh'], 213, 'ISRC-SM'),
    listing('Cooler Than Me - Gigamesh Remix', posner, 232, 'ISRC-GR'),
    listing('Cooler Than Me', [posner, 'Getter'], 196, 'ISRC-GT'),
    listing('Song X', 'Artist X', 250, 'ISRC-X1'),
    listing('Song X - Radio Edit', 'Artist X', 210, 'ISRC-X2'),
    listing('Song Y', 'Artist Y', 200, 'ISRC-Y'),
    listing('Song Y', 'Artist Y', 215, 'ISRC-Y'),
    listing('Song Z', 'Artist Z', 200, 'ISRC-Z1'),
    listing('Song Z', 'Artist Z', 230, 'ISRC-Z2'),
    listing('Burning Blue', 'Mariah the Scientist', 55, 'ISRC-B2'),
    listing('Thriller (Instrumental)', 'Michael Jackson', 355, 'ISRC-MJ'),
    listing('Collab Song', ['Artist A', 'Artist B'], 200, 'ISRC-CO'),
    listing('Back To Life (However Do You Want Me)', 'Soul II Soul', 213, 'ISRC-BT'),
  ];
};

const key = 'mike posner|cooler than me';
const record = (usdbId: number): SongRangeRecord => ({
  range: { low: 50, high: 70, tessitura: 60, source: 'note-file', confidence: 'high', fastLyrics: false, usdbId },
  log: { trackId: 't', title: 'Cooler Than Me', artist: posner, outcome: 'note-file', reason: 'USDB', at: '2026-01-01T00:00:00.000Z' },
});
const ranges = new Map([[key, record(7)]]);
const usdbIndex: UsdbIndexEntry[] = [
  { id: 7, key, artist: posner, title: 'Cooler Than Me [DUET]', views: 900 },
  { id: 8, key, artist: posner, title: 'Cooler Than Me', views: 100 },
];

describe('identityAudit', () => {
  const audit = identityAudit({ tracks: library(), ranges, usdbIndex });
  const total = (id: string) => audit.lists.find((l) => l.id === id)?.total;
  const examples = (id: string) => audit.lists.find((l) => l.id === id)!.examples;

  it('counts what was read, what was left out and how the listings grouped', () => {
    expect(audit.summary).toMatchObject({
      listings: 17,
      with: { isrc: 17, length: 17, severalArtists: 4, popularity: 0 },
      dropped: { littleSinging: 1, snippets: 1 },
      songs: 10,
      songsWithSeveralListings: 4,
      largestSong: 3,
      mergedBy: { isrc: 4, 'names+length': 0, edit: 0, packaging: 1 },
      songsByWords: { plain: 7, packagingOnly: 1, unlistedOnly: 1, differentVersion: 1 },
      database: { lookupKeys: 7, withStoredRange: 1, usdbEntries: 2 },
    });
  });

  it('lists merges to eyeball and songs kept apart', () => {
    expect(total('isrc-far')).toBe(1); // Song Y, 15 s apart
    expect(total('packaging-far')).toBe(1); // Song X - Radio Edit, 40 s apart
    expect(total('near-miss')).toBe(1); // the two Song Z listings
    expect(total('snippet')).toBe(1);
    expect(total('little-singing')).toBe(1);
    expect(examples('packaging-far')[0]).toContain('40 s apart');
  });

  it('lists the merges made without an ISRC, which are the ones most likely to be wrong', () => {
    expect(total('soft-merge')).toBe(1);
    expect(examples('soft-merge')[0]).toContain('"Song X - Radio Edit" by Artist X (3:30) joined "Song X" by Artist X (4:10), 40 s apart (packaging)');
  });

  it('lists ISRC merges where the title or the credited artists differ, such as a reused ISRC', () => {
    expect(total('isrc-title')).toBe(0);
    const reused = identityAudit({ tracks: [listing('Wonderwall', 'Oasis', 258, 'ISRC-W'), listing("Don't Look Back in Anger", 'Oasis', 288, 'ISRC-W'), listing('Cover', 'Someone', 200, 'ISRC-C'), listing('Cover', 'Someone Else', 200, 'ISRC-C')], ranges, usdbIndex });
    expect(reused.lists.find((l) => l.id === 'isrc-title')!.total).toBe(2);
  });

  it('lists possible untagged remixes and collaborations: two or more credited artists, no feat., no version tag', () => {
    expect(total('collab')).toBe(3); // Single Mix, Getter, Collab Song
  });

  it('shows where the unchanged lookup key shares a range across songs, and which stored ranges a different-version song reads', () => {
    expect(total('shared-key')).toBe(2); // the Cooler Than Me key (3 songs) and the Song Z key (2 songs kept apart)
    expect(examples('shared-key')[0]).toContain(key);
    expect(total('variant-range')).toBe(1);
    expect(examples('variant-range')[0]).toContain('Gigamesh Remix');
    expect(examples('variant-range')[0]).toContain('note-file, high confidence');
  });

  it('finds a plain song whose stored range came from a duet entry although a plain entry exists', () => {
    expect(total('wrong-entry')).toBe(2); // the Single Mix and the Getter listing read the key's range, which came from "[DUET]"
    expect(examples('wrong-entry')[0]).toContain('Cooler Than Me [DUET]');
    expect(identityAudit({ tracks: library(), ranges, usdbIndex: usdbIndex.slice(0, 1) }).lists.find((l) => l.id === 'wrong-entry')!.total).toBe(0);
  });

  it('counts the most common tags, which are the candidates for the word lists', () => {
    expect(audit.topTags.version).toEqual([['gigamesh remix', 1]]);
    expect(audit.topTags.unlisted).toEqual([['however do you want me', 1]]);
    const tags = identityAudit({ tracks: [listing('A (Live)', 'X', 200, 'I1'), listing('B (Live)', 'X', 200, 'I2'), listing('C (Remix)', 'X', 200, 'I3'), listing('D (Odd)', 'X', 200, 'I4'), listing('E (Odd)', 'X', 200, 'I5')] });
    expect(tags.topTags.version).toEqual([['live', 2], ['remix', 1]]);
    expect(tags.topTags.unlisted).toEqual([['odd', 2]]);
  });

  it('writes one CSV row per listing, left-out ones included, with the song, how it joined and its flags', () => {
    const csv = identityAuditCsv(audit.rows).trimEnd().split('\n');
    expect(csv[0]).toBe('song,role,joined by,seconds from anchor,title,credited artists,length,ISRC,Spotify track id,play rank,lookup key,version tags,flags');
    expect(csv).toHaveLength(1 + 17);
    expect(csv.find((l) => l.includes('Song Y') && l.includes('isrc'))).toContain('isrc-far');
    expect(csv.some((l) => l.startsWith(',left out: snippet'))).toBe(true);
  });

  it('quotes CSV cells that hold commas or quotes', () => {
    const row = audit.rows[0]!;
    expect(identityAuditCsv([{ ...row, title: 'Rock, "Paper"' }])).toContain('"Rock, ""Paper"""');
  });

  it('does not call a range wrong when it came from the plain entry itself', () => {
    expect(identityAudit({ tracks: library(), ranges: new Map([[key, record(8)]]), usdbIndex }).lists.find((l) => l.id === 'wrong-entry')!.total).toBe(0);
  });

  it('leaves a guest and a remix out of the possible untagged collaborations', () => {
    const tagged = identityAudit({ tracks: [listing('Song (feat. B)', ['A', 'B'], 200, 'I1'), listing('Other (Remix)', ['A', 'B'], 200, 'I2'), listing('Third', ['A', 'B'], 200, 'I3')] });
    expect(tagged.lists.find((l) => l.id === 'collab')!.examples).toEqual(['"Third" by A & B (3:20)']);
  });

  it('does not list an ISRC merge exactly 10 s apart as far, and ignores tracks without a length when looking for near misses', () => {
    expect(identityAudit({ tracks: [listing('Song', 'Artist', 200, 'ISRC-T'), listing('Song', 'Artist', 210, 'ISRC-T')] }).lists.find((l) => l.id === 'isrc-far')!.total).toBe(0);
    const noLength = identityAudit({ tracks: [{ ...listing('Song', 'Artist', 200, 'I1'), durationMs: undefined } as Track, { ...listing('Song', 'Artist', 230, 'I2'), durationMs: undefined } as Track] });
    expect(noLength.lists.find((l) => l.id === 'near-miss')!.total).toBe(0);
  });

  it('counts the labels after a dash, which keep a listing apart unless the ISRC joins it', () => {
    const labelled = identityAudit({ tracks: [listing('A - Some Label', 'X', 200, 'I1'), listing('B - Some Label', 'X', 200, 'I2'), listing('C - Other Label', 'X', 200, 'I3')] });
    expect(labelled.topTags.labels).toEqual([['some label', 2], ['other label', 1]]);
    expect(labelled.summary.songsByWords.unlistedOnly).toBe(3);
    expect(identityAuditText(labelled)).toContain('Most common unlisted labels after a dash');
  });

  it('keeps a gap of 10.04 s from rounding down to 10 s and out of the list of merges over 10 s', () => {
    const near = identityAudit({ tracks: [listing('Song', 'Artist', 200, 'ISRC-G'), listing('Song', 'Artist', 210.04, 'ISRC-G')] });
    expect(near.lists.find((l) => l.id === 'isrc-far')!.total).toBe(1);
  });
});

describe('identityAuditText', () => {
  const audit = identityAudit({
    tracks: library(),
    sources: [
      { name: 'saved songs', tracks: library().slice(0, 4) },
      { name: 'playlists', tracks: [{ ...library()[0]!, isrc: undefined } as Track] },
    ],
    ranges,
    usdbIndex,
  });
  const text = identityAuditText(audit);

  it('makes a summary with counts and example titles but no ISRCs or track ids', () => {
    expect(text).toContain('Listings read: 17');
    expect(text).toContain('Songs after grouping: 10 (5 of 15 listings merged into another)');
    expect(text).toContain('[isrc-far] Joined by ISRC but more than 10 s apart: 1');
    expect(text).not.toMatch(/ISRC-|track-\d/);
  });

  it('shows what each Spotify list carried, so one endpoint without ISRC cannot hide in the total', () => {
    expect(text).toContain('saved songs: 4 listings; ISRC on 4 (100%), length on 4 (100%), 2+ credited artists on 1 (25%)');
    expect(text).toContain('playlists: 1 listings; ISRC on 0 (0%)');
  });

  it('says how much the database held, and warns when stored ranges or the USDB index are empty', () => {
    expect(text).toContain('Database: stored ranges for 1 of 7 lookup keys; 2 USDB index entries');
    expect(text).not.toContain('WARNING');
    const empty = identityAuditText(identityAudit({ tracks: library(), ranges: new Map(), usdbIndex: [] }));
    expect(empty).toContain('WARNING: one of these is empty');
    expect(identityAuditText(identityAudit({ tracks: library(), ranges, usdbIndex: [] }))).toContain('WARNING: one of these is empty'); // ranges but no index
    expect(identityAuditText(identityAudit({ tracks: library(), ranges: new Map(), usdbIndex }))).toContain('WARNING: one of these is empty'); // an index but no ranges
  });

  it('says so when no database was read, rather than reporting the database lists as clean', () => {
    const none = identityAudit({ tracks: library() });
    expect(none.summary.database).toBeNull();
    expect(none.lists.filter((l) => l.total === null).map((l) => l.id)).toEqual(['variant-range', 'wrong-entry']);
    const noneText = identityAuditText(none);
    expect(noneText).toContain('Stored ranges and the USDB index: not checked (no database was read)');
    expect(noneText).toContain('Not checked: [variant-range] [wrong-entry]');
    expect(noneText).not.toContain('Nothing found for: [variant-range]');
  });

  it('collapses the lists with nothing in them into one line, and says how many examples were left out', () => {
    expect(identityAuditText(identityAudit({ tracks: [], ranges: new Map(), usdbIndex: [] }))).toContain('Nothing found for: [soft-merge] [isrc-far] [packaging-far] [isrc-title]');
    const many = Array.from({ length: 10 }, (_, i) => listing(`Snippet ${i}`, 'Artist', 30, `ISRC-S${i}`));
    expect(identityAuditText(identityAudit({ tracks: many }))).toContain('... and 2 more (see the CSV)');
  });
});

describe('identityAudit on a library without listing details', () => {
  it('runs on the mock library, where tracks have no ISRC, length or credited artists, and finds each listing its own song', async () => {
    const tracks = await getUserTracks(createMockSpotifyClient(), 'token');
    const audit = identityAudit({ tracks, ranges: new Map(), usdbIndex: [] });
    expect(audit.summary.songs).toBe(MOCK_TRACKS.length);
    expect(audit.summary.with).toEqual({ isrc: 0, length: 0, severalArtists: 0, popularity: expect.any(Number) });
    expect(audit.summary.mergedBy).toEqual({ isrc: 0, 'names+length': 0, edit: 0, packaging: 0 });
  });
});
