import { describe, expect, it } from 'vitest';
import { createDeezerClient, deezerQuery, matchesKey, pickDeezerHit, recordingsOf, type DeezerTrack } from '../../src/lib/popularity/deezer';
import { songKey } from '../../src/lib/songs/resolve';

const track = (artist: string, title: string, rank: number, id = rank): DeezerTrack => ({ id, title, rank, artist: { name: artist } });

describe('deezerQuery', () => {
  it('searches the plain artist and title, without version tags or featured artists', () => {
    expect(deezerQuery('2 Chainz', 'Presha (with Lil Wayne)')).toBe('2 chainz presha');
    expect(deezerQuery('Toto', 'Africa - Remastered 2011')).toBe('toto africa');
  });
});

describe('matchesKey', () => {
  const key = songKey('Mariah the Scientist', 'Burning Blue');
  it('accepts the same artist and title, whatever the case, tags or punctuation', () => {
    expect(matchesKey(key, track('Mariah The Scientist', 'Burning Blue', 1))).toBe(true);
    expect(matchesKey(songKey('The Rolling Stones', 'Paint It, Black'), track('The Rolling Stones', 'Paint It Black', 1))).toBe(true);
    expect(matchesKey(songKey('Queen', 'Bohemian Rhapsody'), track('Queen', 'Bohemian Rhapsody (Live Aid)', 1))).toBe(true);
  });
  it('accepts an artist named with words added, like "Ms. Lauryn Hill" for "Lauryn Hill"', () => {
    expect(matchesKey(songKey('Ms. Lauryn Hill', 'Doo Wop (That Thing)'), track('Lauryn Hill', 'Doo Wop (That Thing)', 1))).toBe(true);
  });
  it('refuses another artist, another title, and karaoke or instrumental versions', () => {
    expect(matchesKey(key, track('Lil Barberi', "I'm a fan of mariah the scientist", 1))).toBe(false);
    expect(matchesKey(key, track('ZZang KARAOKE', 'Burning Blue (Instrumental Karaoke Version)', 1))).toBe(false);
    expect(matchesKey(key, track('Mariah The Scientist', 'Burning Blue (Instrumental)', 1))).toBe(false);
    expect(matchesKey(key, track('Mariah The Scientist', 'Burning', 1))).toBe(false);
  });
});

describe('pickDeezerHit', () => {
  it('takes the original over a live take, and never another artist\'s track', () => {
    const results = [track('Toto', 'Africa (Live)', 999_000), track('Toto', 'Africa', 964_180), track('Weezer', 'Africa', 999_999)];
    expect(pickDeezerHit(songKey('Toto', 'Africa'), results)).toEqual({ rank: 964_180, deezerId: 964_180, artist: 'Toto', title: 'Africa' });
  });
  it('is null when nothing matches', () => {
    expect(pickDeezerHit(songKey('Toto', 'Africa'), [track('Weezer', 'Africa', 1)])).toBeNull();
  });
});

describe('createDeezerClient', () => {
  it('waits out a quota error and tries again', async () => {
    const answers = [{ error: { code: 4, message: 'Quota limit exceeded' } }, { data: [track('Toto', 'Africa', 5)] }];
    const urls: string[] = [];
    const waits: number[] = [];
    const client = createDeezerClient({
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => answers.shift() };
      },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await client.search('toto africa')).toEqual([track('Toto', 'Africa', 5)]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('https://api.deezer.com/search?q=toto%20africa&limit=10');
    expect(waits).toContain(5000);
  });
  it('gives up after its tries', async () => {
    const client = createDeezerClient({ fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }), sleep: async () => {}, tries: 2 });
    await expect(client.search('x')).rejects.toThrow('HTTP 503');
  });
});

describe('matchesKey, names written differently', () => {
  it('reads "&" as "and" and a medley by its first song', () => {
    expect(matchesKey(songKey('KC & The Sunshine Band', 'Boogie Shoes'), track('KC and the Sunshine Band', 'Boogie Shoes', 1))).toBe(true);
    expect(matchesKey(songKey('Chicago', "Hard to Say I'm Sorry - 2009 Remaster"), track('Chicago', "Hard to Say I'm Sorry / Get Away", 1))).toBe(true);
  });
  it('reads "+" as "and", and an apostrophe as part of its word: Fool\'s Garden is Deezer\'s "Fools Garden"', () => {
    expect(matchesKey(songKey('Fool’s Garden', 'Lemon Tree'), track('Fools Garden', 'Lemon Tree', 1))).toBe(true);
    expect(matchesKey(songKey('Walk The Moon', 'Shut Up + Dance'), track('WALK THE MOON', 'Shut Up and Dance', 1))).toBe(true);
    expect(matchesKey(songKey('Journey', 'Don’t Stop Believin’'), track('Journey', "Don't Stop Believin'", 1))).toBe(true);
  });
});

// ---------- QWW-59: the original recording, and titles with a bracketed part ----------
// Search results as Deezer's API returned them on 12 Nov 2026 (id, rank, artist, title, title_short, title_version),
// trimmed to the ones that matter. Deezer splits a version part off some titles (title_version) and not others.

const dz = (id: number, rank: number, artist: string, title: string, version?: string): DeezerTrack => ({
  id,
  rank,
  title: version ? `${title} ${version}` : title,
  ...(version ? { title_short: title, title_version: version } : {}),
  artist: { name: artist },
});
const pick = (artist: string, title: string, results: DeezerTrack[], ours = title) => pickDeezerHit(songKey(artist, title), results, ours)?.deezerId ?? null;

describe('pickDeezerHit, the original studio recording (QWW-59)', () => {
  // "onerepublic counting stars" returned the 2023 re-recording and a live album take, never the 2013 original
  // (65759979, rank 799,652, readable, with a preview), which is why song_deezer held the 2023 Version. The original
  // is ranked higher here than it is, so the test shows it wins on being the original, not on its rank.
  const countingStars = [
    dz(2444664705, 900_000, 'OneRepublic', 'Counting Stars (2023 Version)'),
    dz(1640375672, 337_021, 'OneRepublic', 'Counting Stars', '(from One Night In Malibu)'),
    dz(76810529, 68_317, "Counting By 2's", 'Counting Stars (OneRepublic Cover)'),
    dz(65759979, 799_652, 'OneRepublic', 'Counting Stars'),
  ];

  it('Counting Stars: takes the 2013 original over "(2023 Version)", even when the re-recording ranks higher', () => {
    expect(pick('OneRepublic', 'Counting Stars', countingStars)).toBe(65759979);
  });

  it('Counting Stars: a title that names "(2023 Version)" still gets the original when Deezer has it', () => {
    expect(pick('OneRepublic', 'Counting Stars', countingStars, 'Counting Stars (2023 Version)')).toBe(65759979);
  });

  it('Time Of Your Life: finds Green Day\'s "Good Riddance (Time of Your Life)", and not one of its live takes', () => {
    const results = [
      dz(778429, 773_489, 'Green Day', 'Good Riddance (Time of Your Life)'),
      dz(679787, 262_391, 'Green Day', 'Good Riddance (Time of Your Life)', '(Live at Milton Keynes National Bowl, Milton Keynes, England, 6/18/05)'),
      dz(2125323967, 118_902, 'Green Day', 'Good Riddance (Time of Your Life)', '(Live at the Electric Factory, Philadelphia 11/14/97)'),
      dz(10540407, 26_038, 'Various Musique', 'Good Riddance (Time Of Your Life) (Originally By Green Day)'),
    ];
    expect(pick('Green Day', 'Time Of Your Life', results)).toBe(778429);
    expect(pick('Green Day', 'Good Riddance (Time Of Your Life)', results)).toBe(778429);
    // Before, the bracketed part never counted as the title: no match at all.
    expect(matchesKey(songKey('Green Day', 'Time Of Your Life'), results[0]!)).toBe(true);
  });

  it('passes over a live take, a remix, a sped-up edit, a cover and a commentary track, however well they rank', () => {
    const footloose = [
      dz(1296073692, 227_511, 'Kenny Loggins', 'Footloose', '(Live at John F. Kennedy Stadium, 13th July 1985)'),
      dz(1013285, 111_963, 'Kenny Loggins', 'Footloose', '(Live)'),
      dz(4155200162, 153_987, 'Kenny Loggins', 'Footloose'),
    ];
    expect(pick('Kenny Loggins', 'Footloose', footloose)).toBe(4155200162); // it used to take the live take, on rank
    const passedOver = [
      dz(1, 990_000, 'a-ha', 'Take on Me', '(Kygo Remix)'),
      dz(2, 980_000, 'a-ha', 'Take on Me (Sped Up)'),
      dz(3, 970_000, 'a-ha', 'Take on Me', '(Commentary)'),
      dz(4, 960_000, 'a-ha', 'Take on Me (a-ha Cover)'),
      dz(5, 950_000, 'a-ha', 'Take On Me', '(MTV Unplugged)'),
      dz(664107, 100_000, 'a-ha', 'Take on Me'),
    ];
    expect(pick('a-ha', 'Take On Me', passedOver)).toBe(664107);
    expect(pick('a-ha', 'Take On Me', passedOver.slice(0, 5))).toBeNull(); // none of them is the song as recorded
  });

  it('counts release tags as the original: remasters, radio edits, single mixes and soundtrack tags', () => {
    const heyJude = [dz(116348632, 859_208, 'The Beatles', 'Hey Jude', '(Remastered 2015)'), dz(126848613, 674_633, 'The Beatles', 'Hey Jude'), dz(122172010, 900_000, 'The Beatles', 'Hey Jude', '(Take 2)')];
    expect(pick('The Beatles', 'Hey Jude', heyJude)).toBe(116348632);
    const letItGo = [
      dz(72371930, 709_827, 'Idina Menzel', 'Let It Go', '(From "Frozen"/Soundtrack Version)'),
      dz(78106761, 800_000, 'Idina Menzel', 'Let It Go', '(From "Frozen"/Dave Audé Club Remix)'),
      dz(562854602, 750_000, 'Idina Menzel', 'Let It Go', '(Live)'),
    ];
    expect(pick('Idina Menzel', 'Let It Go', letItGo)).toBe(72371930);
    const takeOnMe = [dz(859733152, 395_327, 'a-ha', 'Take on Me', '(1985 Single Mix; 2015 Remaster)'), dz(432951302, 707_081, 'a-ha', 'Take On Me', '(2017 Acoustic)')];
    expect(pick('a-ha', 'Take On Me', takeOnMe)).toBe(859733152);
  });

  it('takes a re-recording only when there is no original: Deezer\'s search has no "Shake It Off" but Taylor\'s Version', () => {
    const results = [
      dz(2512293231, 696_539, 'Taylor Swift', "Shake It Off (Taylor's Version)"),
      dz(602092482, 195_831, 'Taylor Swift', 'Shake It Off', '(Commentary)'),
      dz(132744476, 171_345, "Tonight i'm Taylor Swift", 'Shake It Off'), // a tribute act, plain title
      dz(721346612, 104_307, 'Sean Redmond', 'Shake It Off (Originally Performed by Taylor Swift)'),
    ];
    expect(pick('Taylor Swift', 'Shake It Off', results)).toBe(2512293231);
    // With only the act's track, it is still a match: its name is Taylor Swift's with words added.
    expect(pick('Taylor Swift', 'Shake It Off', results.slice(2, 3))).toBe(132744476);
  });

  it('takes the best of the versions Deezer names when none is plain: "My Heart Will Go On (Love Theme from "Titanic")"', () => {
    const results = [
      dz(14552280, 852_618, 'Céline Dion', 'My Heart Will Go On', '(Love Theme from "Titanic")'),
      dz(17000055, 680_400, 'Céline Dion', 'My Heart Will Go On', '(Love Theme from "Titanic")'),
      dz(17000067, 900_000, 'Céline Dion', 'My Heart Will Go On (Dialogue Mix)', '(includes "Titanic" film dialogue)'),
      dz(129225918, 950_000, 'Céline Dion', 'My Heart Will Go On', '(Tony Moran Mix)'),
    ];
    expect(pick('Celine Dion', 'My Heart Will Go On', results)).toBe(14552280);
  });

  it('takes the original for a note file of a live take too, and the live take only when there is no original', () => {
    // Journey's "Don't Stop Believin' (Live in Houston)" note file: the studio track is the song people know, and its
    // rank (916,669 against the live take's 470,979) is the song's popularity.
    const results = [dz(1079668, 964_180, 'Toto', 'Africa'), dz(649767712, 345_995, 'Toto', 'Africa', '(Live)')];
    expect(pick('Toto', 'Africa', results, 'Africa (Live)')).toBe(1079668);
    expect(pick('Toto', 'Africa', results.slice(1), 'Africa (Live)')).toBe(649767712);
    expect(pick('Toto', 'Africa', results.slice(1))).toBeNull(); // a plain title never takes a live take
  });
});

describe('matchesKey, tribute acts', () => {
  it('refuses an artist named as a tribute, a karaoke act or a cover act of the singer', () => {
    for (const name of ['OneRepublic Tribute Band', 'Karaoke Hits of OneRepublic', 'Made Famous by OneRepublic', 'OneRepublic Covers']) {
      expect(matchesKey(songKey('OneRepublic', 'Counting Stars'), dz(1, 1, name, 'Counting Stars')), name).toBe(false);
    }
    expect(matchesKey(songKey('OneRepublic', 'Counting Stars'), dz(1, 1, 'OneRepublic', 'Counting Stars'))).toBe(true);
  });
});

describe('recordingsOf', () => {
  it.each<[string, string[]]>([
    ['Counting Stars (2023 Version)', ['version']],
    ['Love Story (Taylor’s Version)', ['version']],
    ['(Everything I Do) I Do It For You (Classic Version)', ['version']],
    ['Let It Go (German Version)', ['version']],
    ['Take On Me (2017 Acoustic)', ['version']],
    ['Africa (Live)', ['live']],
    ['Take On Me (MTV Unplugged)', ['live']],
    ['I Will Always Love You (Live Version)', ['live']],
    ['Take on Me (Kygo Remix)', ['remix']],
    ['I Will Always Love You (Hex Hector Radio Mix)', ['remix']],
    ['Song (Sped Up)', ['sped-up']],
    ['Song (Slowed + Reverb)', ['sped-up']],
    ['Counting Stars (OneRepublic Cover)', ['cover']],
    ['Shake It Off (Commentary)', ['not-a-song']],
    ['Hey Jude (Take 2)', ['not-a-song']],
  ])('%s is %j', (title, kinds) => {
    expect([...recordingsOf(title)].sort()).toEqual(kinds);
  });

  it.each([
    'Counting Stars',
    'Hey Jude (Remastered 2015)',
    'Bohemian Rhapsody - Remastered 2011',
    'Flashdance...What a Feeling (Radio Edit)',
    'Take on Me (Single Mix)',
    'Take on Me (1985 Single Mix; 2015 Remaster)',
    'Hey Jude (Single Version)',
    'I Will Always Love You (Film Version)',
    'Let It Go (From "Frozen"/Soundtrack Version)',
    'Shallow (feat. Bradley Cooper)',
    'Good Riddance (Time of Your Life)',
    "(I Can't Get No) Satisfaction",
  ])('%s is the original', (title) => {
    expect([...recordingsOf(title)]).toEqual([]);
  });
});
