import { describe, expect, it } from 'vitest';
import {
  albumRecordings,
  createDeezerClient,
  creditedActs,
  deezerQuery,
  findDeezerTrack,
  HAND_CHECKED,
  matchesKey,
  pickDeezerHit,
  recordingsOf,
  TITLE_SEARCH_LIMIT,
  type DeezerArtist,
  type DeezerTrack,
  type DeezerTrackDetail,
} from '../../src/lib/popularity/deezer';
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
    ['Let It Go (German Version)', ['other-song']],
    ['Nothing Else Matters (Jungle Cruise Version Part 2)', ['other-song']],
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
    'Thriller (25th Anniversary Edition)',
    'Rumours (Deluxe Edition)',
    'Shallow (feat. Bradley Cooper)',
    'Good Riddance (Time of Your Life)',
    "(I Can't Get No) Satisfaction",
  ])('%s is the original', (title) => {
    expect([...recordingsOf(title)]).toEqual([]);
  });
});

describe('pickDeezerHit, after the review of QWW-59', () => {
  it('reads a live take as live wherever Deezer writes it: "(Live Aid)" in the title, or a version part with no brackets', () => {
    const results = [dz(1, 900_000, 'Queen', 'Bohemian Rhapsody (Live Aid)'), dz(2, 850_000, 'Queen', 'Bohemian Rhapsody', 'Live'), dz(3, 800_000, 'Queen', 'Bohemian Rhapsody')];
    expect(pick('Queen', 'Bohemian Rhapsody', results)).toBe(3);
  });

  it('never takes a language version for a plain title, even with nothing else to take', () => {
    expect(pick('ABBA', 'Chiquitita', [dz(1, 500_000, 'ABBA', 'Chiquitita (Spanish Version)')])).toBeNull();
    expect(pick('ABBA', 'Chiquitita', [dz(1, 500_000, 'ABBA', 'Chiquitita (Spanish Version)')], 'Chiquitita (Spanish Version)')).toBe(1);
  });

  it('counts a title or a co-credit as the artist\'s own credit, so the original beats the artist\'s re-recording', () => {
    const lauryn = [dz(1, 100_000, 'Lauryn Hill', 'Doo Wop (That Thing) (2018 Version)'), dz(2, 500_000, 'Ms. Lauryn Hill', 'Doo Wop (That Thing)')];
    expect(pick('Lauryn Hill', 'Doo Wop (That Thing)', lauryn)).toBe(2);
    const wailers = [dz(1, 100_000, 'Bob Marley', 'Three Little Birds (Acoustic)'), dz(2, 600_000, 'Bob Marley & The Wailers', 'Three Little Birds')];
    expect(pick('Bob Marley', 'Three Little Birds', wailers)).toBe(2);
    // Other words before the name are not a credit: a tribute act's plain title stays behind the artist's re-recording.
    const tribute = [dz(1, 696_539, 'Taylor Swift', "Shake It Off (Taylor's Version)"), dz(2, 900_000, 'We Love Taylor Swift', 'Shake It Off')];
    expect(pick('Taylor Swift', 'Shake It Off', tribute)).toBe(1);
  });

  it('counts "(Deluxe Edition)" as the original release', () => {
    expect(pick('Fleetwood Mac', 'Dreams', [dz(1, 900_000, 'Fleetwood Mac', 'Dreams', '(Deluxe Edition)'), dz(2, 300_000, 'Fleetwood Mac', 'Dreams (Live)')])).toBe(1);
  });
});

// ---------- QWW-67: the album, other names for a credit, and the lookup's fallbacks ----------
// Tracks as Deezer's API returned them on 12 Nov 2026 (id, rank, artist, title, album), trimmed to the ones that matter.

const dza = (id: number, rank: number, artist: string, title: string, album: string, version?: string): DeezerTrack => ({
  ...dz(id, rank, artist, title, version),
  album: { title: album },
});

describe('albumRecordings (QWW-67)', () => {
  it.each<[string, string[]]>([
    ['MTV Unplugged In New York', ['live']],
    ['Anniversary | Oral Fixation (20th) and Pies Descalzos (30th) LIVE', ['live']],
    ['One More Car, One More Rider (Live)', ['live']],
    ['Unshatter Film Soundtrack (Live in São Paulo)', ['live']],
    ['Live at Wembley Stadium', ['live']],
    ['Live 1975-85', ['live']],
    ['Deezer Session', ['live']],
    ['Summertime Sadness (Lana Del Rey Vs. Cedric Gervais) (Cedric Gervais Remix)', ['remix']],
    ['I Let Her Go (Remixes)', ['remix']],
    ['Sadnecessary (Acoustic Version)', ['version']],
    ["Red (Taylor's Version)", ['version']],
    ['Party Tyme Karaoke - Pop Male Hits 8 (Vocal Versions)', ['cover']],
    ['Let Her Go - Tribute to Passenger', ['cover']],
  ])('%s is %j', (album, kinds) => {
    expect([...albumRecordings(album)].sort()).toEqual(kinds);
  });

  it.each([
    'Born To Die',
    'Born To Die - The Paradise Edition',
    'Rumours (Deluxe Edition)',
    'Sadnecessary (Bonus Track Version)',
    'Oral Fixation, Vol. 2 (Expanded Edition)',
    'High School Musical 3: Senior Year (Original Motion Picture Soundtrack)',
    'U218 Singles (Deluxe Version)',
    'Live Through This',
    'Alive 2007',
    'Stripped',
    'Undercover',
    'Legend - The Best Of Bob Marley And The Wailers',
  ])('%s says nothing against its tracks', (album) => {
    expect([...albumRecordings(album)]).toEqual([]);
  });
});

describe('pickDeezerHit, the album counts as the title does (QWW-67)', () => {
  it("Hips Don't Lie: passes over a plain title on a live album, however well it ranks", () => {
    const results = [
      dza(3663852612, 877_583, 'Shakira', "Hips Don't Lie", 'Anniversary | Oral Fixation (20th) and Pies Descalzos (30th) LIVE'),
      dza(14896962, 300_557, 'Shakira', "Hips Don't Lie", 'Live From Paris', '(Live Version)'),
      dza(3389132901, 757_492, 'Shakira', "Hips Don't Lie (feat. Wyclef Jean)", 'Oral Fixation, Vol. 2 (Expanded Edition)'),
    ];
    expect(pick('Shakira', "Hips Don't Lie", results)).toBe(3389132901);
    expect(pick('Shakira', "Hips Don't Lie", results.slice(0, 2))).toBeNull();
  });

  it('Let Her Go: a take recorded at Deezer is live, and so is a track on a "Deezer Session" album', () => {
    const results = [
      dza(724841252, 601_419, 'Passenger', 'Let Her Go (Recorded at Deezer, Sao Paulo)', 'Deezer Session'),
      dza(2183569797, 176_556, 'Passenger', 'Let Her Go (Live from San Francisco)', 'Passenger (Live from San Francisco)'),
    ];
    expect(pick('Passenger', 'Let Her Go', results)).toBeNull();
    expect(pick('Passenger', 'Let Her Go', [dza(724841252, 601_419, 'Passenger', 'Let Her Go', 'Deezer Session')])).toBeNull();
  });

  it('Come As You Are: a track on "MTV Unplugged In New York" is live even with a plain title', () => {
    const unplugged = [dza(1, 636_392, 'Nirvana', 'Come As You Are', 'MTV Unplugged In New York')];
    expect(pick('Nirvana', 'Come As You Are', unplugged)).toBeNull();
    expect(pick('Nirvana', 'Come As You Are', unplugged, 'Come As You Are (Live)')).toBe(1);
  });

  it('Stolen Dance: a track on an acoustic album is taken only when there is no original', () => {
    const acoustic = dza(1700988147, 592_248, 'Milky Chance', 'Stolen Dance', 'Sadnecessary (Acoustic Version)');
    const original = dza(1762958607, 544_072, 'Milky Chance', 'Stolen Dance', 'Sadnecessary (Bonus Track Version)');
    expect(pick('Milky Chance', 'Stolen Dance', [acoustic, original])).toBe(1762958607);
    expect(pick('Milky Chance', 'Stolen Dance', [acoustic])).toBe(1700988147);
  });
});

describe('other names for a credit (QWW-67)', () => {
  it('reads a credit as Deezer names the act: Pink is P!nk, ★N Sync is *NSYNC, Dixie Chicks are The Chicks', () => {
    expect(matchesKey(songKey('Pink', 'Just Like a Pill'), dz(15597819, 554_354, 'P!nk', 'Just Like a Pill'))).toBe(true);
    expect(matchesKey(songKey('★N Sync', 'Bye Bye Bye'), dz(71183268, 505_100, '*NSYNC', 'Bye Bye Bye'))).toBe(true);
    expect(matchesKey(songKey('Dixie Chicks', 'Landslide'), dz(1, 1, 'The Chicks', 'Landslide'))).toBe(true);
    // P!nk's track is the artist's own credit, so it beats a longer name that contains "Pink", whatever the rank.
    const pill = [dz(1, 900_000, 'Pink Floyd', 'Just Like a Pill'), dz(15597819, 554_354, 'P!nk', 'Just Like a Pill')];
    expect(pickDeezerHit(songKey('Pink', 'Just Like a Pill'), pill)?.deezerId).toBe(15597819);
  });

  it.each<[string, string[]]>([
    ['u2 and green day', ['u2', 'green day']],
    ['sean kingston / justin bieber', ['sean kingston', 'justin bieber']],
    ['kid cudi vs. crookers', ['kid cudi', 'crookers']],
    ['imagine dragons x j.i.d.', ['imagine dragons', 'j.i.d.']],
    ['bryan adams, rod stewart & sting', ['bryan adams', 'rod stewart', 'sting']],
    ['enrique iglesias with usher', ['enrique iglesias', 'usher']],
    ['bob marley & the wailers', []],
    ['florence and the machine', []],
    ['adele', []],
  ])('creditedActs(%s) is %j', (credit, acts) => {
    expect(creditedActs(credit)).toEqual(acts);
  });

  it('takes one act of a shared credit, "U2" for "U2 and Green Day", below the credit itself', () => {
    const key = songKey('U2 and Green Day', 'The Saints Are Coming');
    const u2 = dza(1574233, 260_934, 'U2', 'The Saints Are Coming', 'U218 Singles (Deluxe Version)');
    expect(pickDeezerHit(key, [u2])?.deezerId).toBe(1574233);
    expect(pickDeezerHit(key, [u2, dz(2, 100, 'U2 & Green Day', 'The Saints Are Coming')])?.deezerId).toBe(2);
    // One act beats a longer name that only contains the credit.
    const sk = songKey('Sean Kingston / Justin Bieber', 'Eenie Meenie');
    expect(pickDeezerHit(sk, [dz(1, 900_000, 'Sean Kingston Tribute', 'Eenie Meenie'), dz(2, 500_000, 'Sean Kingston', 'Eenie Meenie')])?.deezerId).toBe(2);
  });

  it('takes the soundtrack of the film or show a credit names: "Disney’s Aladdin", "Hamilton"', () => {
    const aladdin = songKey('Disney’s Aladdin', 'A Whole New World');
    expect(matchesKey(aladdin, dza(120917666, 430_262, 'Lea Salonga', 'A Whole New World', 'Aladdin (Original Motion Picture Soundtrack)'))).toBe(true);
    expect(matchesKey(aladdin, dza(134928834, 296_473, 'Jon Sarta', 'A Whole New World', 'Disney Piano Classics'))).toBe(false);
    expect(matchesKey(aladdin, dza(1, 1, 'Lea Salonga', 'A Whole New World', 'Aladdin'))).toBe(false); // no soundtrack word
    const hamilton = songKey('Hamilton', 'My Shot');
    expect(pickDeezerHit(hamilton, [dza(107832272, 633_897, 'Lin-Manuel Miranda', 'My Shot', 'Hamilton (Original Broadway Cast Recording)')])?.deezerId).toBe(107832272);
    // The film's name must be whole words of the album's.
    expect(matchesKey(songKey('Up', 'Married Life'), dza(1, 1, 'Michael Giacchino', 'Married Life', 'Upside Down (Original Motion Picture Soundtrack)'))).toBe(false);
  });
});

/** A client that answers from fixed data and records each call. */
function fakeClient(data: {
  search?: Record<string, DeezerTrack[]>;
  artists?: Record<string, DeezerArtist[]>;
  top?: Record<number, DeezerTrack[]>;
  tracks?: Record<number, DeezerTrackDetail>;
}) {
  const calls: string[] = [];
  return {
    calls,
    async search(q: string, limit?: number) {
      calls.push(`search ${q}${limit ? ` (${limit})` : ''}`);
      return data.search?.[q] ?? [];
    },
    async artists(name: string) {
      calls.push(`artists ${name}`);
      return data.artists?.[name] ?? [];
    },
    async artistTop(id: number) {
      calls.push(`top ${id}`);
      return data.top?.[id] ?? [];
    },
    async track(id: number) {
      calls.push(`track ${id}`);
      return data.tracks?.[id] ?? null;
    },
  };
}

describe('findDeezerTrack (QWW-67)', () => {
  // "lana del rey summertime sadness" returned only remixes, a sped-up edit and covers; the original from Born To Die
  // (16149860) is in her top 100.
  const summertime = {
    search: {
      'lana del rey summertime sadness': [
        dza(69419038, 809_798, 'Lana Del Rey', 'Summertime Sadness (Lana Del Rey Vs. Cedric Gervais)', 'Summertime Sadness (Lana Del Rey Vs. Cedric Gervais) (Cedric Gervais Remix)', '(Cedric Gervais Remix)'),
        dza(1927583977, 479_624, 'Lana Del Rey', 'Summertime Sadness', 'Summertime Sadness (Sped Up)', '(Sped Up)'),
        dza(4312131932, 522_229, 'Jaax', 'Summertime Sadness', 'Summertime Sadness'),
        dza(2412060525, 97_495, 'Lana Del Rey Piano Covers', 'Summertime Sadness - Piano Cover', 'Lana Del Rey - Piano Covers'),
      ],
    },
    artists: {
      'lana del rey': [
        { id: 1424821, name: 'Lana Del Rey', nb_fan: 5_846_630 },
        { id: 404449462, name: 'Lana Del Rey', nb_fan: 29 },
        { id: 225697895, name: 'Lana Del Rey Piano Covers', nb_fan: 142 },
      ],
    },
    top: {
      1424821: [dza(16149860, 813_635, 'Lana Del Rey', 'Summertime Sadness', 'Born To Die'), dza(16149858, 700_000, 'Lana Del Rey', 'Video Games', 'Born To Die')],
    },
    tracks: { 16149860: { ...dza(16149860, 813_635, 'Lana Del Rey', 'Summertime Sadness', 'Born To Die'), bpm: 112, release_date: '2012-01-27' } },
  };

  it('Summertime Sadness: when the search has only remixes, takes the original from the artist with the name and the most fans', async () => {
    const client = fakeClient(summertime);
    const found = await findDeezerTrack(client, 'Lana Del Rey', 'Summertime Sadness');
    expect(found.hit).toEqual({ rank: 813_635, deezerId: 16149860, artist: 'Lana Del Rey', title: 'Summertime Sadness', album: 'Born To Die' });
    expect(found.route).toBe('artist');
    // The original settles it: no search on the title alone.
    expect(client.calls).toEqual(['search lana del rey summertime sadness', 'artists lana del rey', 'top 1424821']);
    expect(found.calls).toBe(3);
  });

  it('reads the chosen track by its id once more for its release date, when asked', async () => {
    const client = fakeClient(summertime);
    const found = await findDeezerTrack(client, 'Lana Del Rey', 'Summertime Sadness', { releaseDate: true });
    expect(found.hit?.releaseDate).toBe('2012-01-27');
    expect(client.calls.at(-1)).toBe('track 16149860');
    expect(found.calls).toBe(4);
  });

  it("makes no other call when the search has the original under the artist's own credit", async () => {
    const client = fakeClient({ search: { 'toto africa': [dza(1079668, 964_180, 'Toto', 'Africa', 'Toto IV'), dza(649767712, 345_995, 'Toto', 'Africa (Live)', 'Live')] } });
    const found = await findDeezerTrack(client, 'Toto', 'Africa');
    expect(found).toEqual({ hit: { rank: 964_180, deezerId: 1079668, artist: 'Toto', title: 'Africa', album: 'Toto IV' }, route: 'search', calls: 1 });
    expect(client.calls).toEqual(['search toto africa']);
  });

  it('Pink: searches and looks up the artist as P!nk, never the other act named Pink', async () => {
    const client = fakeClient({
      artists: { 'P!nk': [{ id: 69925, name: 'P!nk', nb_fan: 4_680_904 }, { id: 296088961, name: 'PNK GST ZL', nb_fan: 181 }] },
      top: { 69925: [dza(15597819, 554_354, 'P!nk', 'Just Like a Pill', 'Greatest Hits...So Far!!!')] },
    });
    const found = await findDeezerTrack(client, 'Pink', 'Just Like a Pill');
    expect(found.hit?.deezerId).toBe(15597819);
    expect(client.calls).toEqual(['search p!nk just like a pill', 'artists P!nk', 'top 69925']);
  });

  it('U2 and Green Day: tries the whole credit, then each act', async () => {
    const client = fakeClient({
      artists: { u2: [{ id: 174917877, name: 'U2', nb_fan: 12 }, { id: 432, name: 'U2', nb_fan: 5_000_000 }] },
      top: { 432: [dza(1574233, 260_934, 'U2', 'The Saints Are Coming', 'U218 Singles (Deluxe Version)')] },
    });
    const found = await findDeezerTrack(client, 'U2 and Green Day', 'The Saints Are Coming');
    expect(found.hit?.deezerId).toBe(1574233);
    expect(found.route).toBe('artist');
    expect(client.calls.slice(0, 4)).toEqual(['search u2 and green day the saints are coming', 'artists u2 and green day', 'artists u2', 'top 432']);
  });

  it('Disney’s Aladdin: no artist has the name, so the title alone finds the soundtrack', async () => {
    const client = fakeClient({
      search: {
        'a whole new world': [
          dza(1486760292, 439_485, 'Tiny Moon', 'A Whole New World (Piano Version)', 'Piano Lullabies'),
          dza(120917666, 430_262, 'Lea Salonga', 'A Whole New World', 'Aladdin (Original Motion Picture Soundtrack)'),
        ],
      },
    });
    const found = await findDeezerTrack(client, 'Disney’s Aladdin', 'A Whole New World');
    expect(found.hit?.deezerId).toBe(120917666);
    expect(found.route).toBe('title');
    expect(client.calls).toEqual(['search disney’s aladdin a whole new world', 'artists disney’s aladdin', 'search a whole new world (25)']);
  });

  it('keeps a hand-checked track: Counting Stars is read by its id, with no search', async () => {
    const original = { ...dza(65759979, 799_652, 'OneRepublic', 'Counting Stars', 'Native'), bpm: 122, release_date: '2013-03-22', duration: 257 };
    const client = fakeClient({ tracks: { 65759979: original } });
    const found = await findDeezerTrack(client, 'OneRepublic', 'Counting Stars');
    expect(found.hit).toEqual({ rank: 799_652, deezerId: 65759979, artist: 'OneRepublic', title: 'Counting Stars', album: 'Native', duration: 257, releaseDate: '2013-03-22' });
    expect(found.route).toBe('hand');
    expect(client.calls).toEqual(['track 65759979']);
    expect(HAND_CHECKED.get(songKey('Green Day', 'Time Of Your Life'))).toBe(778429);
  });

  it('is a miss when no route finds the song', async () => {
    const client = fakeClient({});
    expect(await findDeezerTrack(client, 'Patrick Nuo', '5 Days')).toEqual({ hit: null, calls: 3 });
    expect(client.calls).toEqual(['search patrick nuo 5 days', 'artists patrick nuo', 'search 5 days (25)']);
  });
});

describe('createDeezerClient, the artist routes (QWW-67)', () => {
  it("asks for artists by name, an artist's top 100, and a longer search", async () => {
    const urls: string[] = [];
    const client = createDeezerClient({
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      },
      sleep: async () => {},
    });
    await client.artists('P!nk');
    await client.artistTop(69925);
    await client.search('summertime sadness', TITLE_SEARCH_LIMIT);
    expect(urls).toEqual([
      'https://api.deezer.com/search/artist?q=P!nk&limit=10',
      'https://api.deezer.com/artist/69925/top?limit=100',
      'https://api.deezer.com/search?q=summertime%20sadness&limit=25',
    ]);
  });
});
