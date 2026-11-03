import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/lib/contracts';
import { groupListings, listingProfile, MIN_SONG_S, parseTitle, SAME_RECORDING_S, SAME_SONG_S, withoutListingDetails } from '../../src/lib/songs/identity';

// Lookalikes of real Spotify listings (invented ids and ISRCs): the repo is public, so no Spotify response is copied in.
let rank = 0;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
function listing(title: string, artists: string | string[], seconds: number, isrc?: string, playRank = rank++): Track {
  const names = Array.isArray(artists) ? artists : [artists];
  const credited = names.map((name) => ({ id: `artist-${slug(name)}`, name }));
  const track: Track = {
    id: `t${playRank}-${slug(title)}`,
    title,
    artist: names[0]!,
    artistId: credited[0]!.id,
    spotifyUrl: '',
    playRank,
    artists: credited,
    durationMs: Math.round(seconds * 1000),
  };
  if (isrc) track.isrc = isrc;
  return track;
}
const songsOf = (...listings: Track[]) => groupListings(listings).songs;
const titlesOf = (songs: ReturnType<typeof groupListings>['songs']) => songs.map((s) => s.members.map((m) => m.track.title));
const kinds = (title: string) => parseTitle(title).tags.map((t) => `${t.text}:${t.kind}`);
const kindsOf = (title: string) => parseTitle(title).tags.map((t) => t.kind);
const EN_DASH = String.fromCharCode(0x2013); // a dash separator some titles use

describe('parseTitle', () => {
  it('reads packaging, cut, guest, version and unlisted tags from brackets and from a dash tail', () => {
    expect(kinds('Folded (Remix) [feat. Ne-Yo]')).toEqual(['remix:version', 'feat. ne-yo:featured']);
    expect(kinds('Cooler Than Me - Single Mix')).toEqual(['single mix:cut']);
    expect(kinds("Love Story (Taylor’s Version)")).toEqual(["taylor's version:cut"]);
    expect(kinds('Halo - Remastered 2011')).toEqual(['remastered 2011:packaging']);
    expect(kinds('Song (Deluxe Edition) [Explicit]')).toEqual(['deluxe edition:packaging', 'explicit:packaging']);
    expect(kinds('Back To Life (However Do You Want Me)')).toEqual(['however do you want me:unlisted']);
    expect(kinds('Folded (Live) - Spotify Live Room')).toEqual(['live:version', 'spotify live room:version']);
  });

  it('treats every remaster, edition and canonical-version spelling as packaging', () => {
    for (const tag of ['Remastered', 'Remastered 2011', 'Digitally Remastered', '2011 Remaster', 'Remastered 2011 Version', 'Stereo Remaster', '2011 Mix', 'Mono', 'Explicit', 'Clean Version', 'Deluxe', 'Super Deluxe Edition', 'Anniversary Edition', 'Expanded Edition', 'Bonus Track', 'Album Version', 'Original Mix', 'LP Version', 'Original Motion Picture Soundtrack']) {
      expect(kindsOf(`Song - ${tag}`), tag).toEqual(['packaging']);
    }
  });

  it('treats every shortened-cut spelling as a cut', () => {
    for (const tag of ['Radio Edit', 'Single Version', 'Single Mix', 'Short Edit', 'Video Edit', 'Edited Version', 'Radio Cut', 'UK Radio Edit', 'Edit', "Taylor's Version", 'Re-Recorded']) {
      expect(kindsOf(`Song (${tag})`), tag).toEqual(['cut']);
    }
  });

  it('treats named mixes, studio-processed copies and the other version words as different versions', () => {
    for (const tag of [
      'Gigamesh Remix', 'Remixed', 'RMX', 'Mash-Up', 'Mashup', 'VIP Mix', 'Rework', 'Flip', 'Bootleg', 'Human Nature Radio Mix', 'Kygo Edit',
      'Live', 'Live at Wembley', 'Live from the Vault', 'Unplugged', 'Apple Music Session', 'Tiny Desk Concert', 'Acoustic', 'Acoustic Version', 'Stripped', 'Piano Version',
      'A Cappella', 'Acappella', 'A-Cappella', 'Orchestral', 'Orchestra Version', 'Demo', 'In Concert', 'Spotify Singles', 'Ao Vivo', 'En Vivo',
      'Extended Mix', 'Club Mix', '12-Inch Version', '12" Version',
      'Sped Up', 'Sped-Up', 'Slowed + Reverb', 'Reverbed', 'Nightcore', 'Chopped and Screwed', 'Bass Boosted', '8D Audio', '16D Audio',
      'Duet Version', 'Alternate Version', 'Alternative Version', 'Film Version', 'Cover', 'Tribute', 'Medley', 'Take 2',
      'Spanish Version', 'Eng Ver.', 'Jpn Ver.', 'Spanish', 'Tamil Version', 'Reprise', 'Interlude', 'Skit', 'Intro', 'Outro', 'Pt. 2', 'Part II', 'Part Four', 'Part VII',
      'Off Vocal', 'Inst.', 'Instrumentals', 'Minus One', 'Without Vocals', 'Backing Tracks',
    ]) {
      expect(kindsOf(`Song (${tag})`), tag).toContain('version');
    }
  });

  it('reads a guest before a version word, so a guest named "Live Nation" or "The Piano Guys" is a guest', () => {
    expect(kinds('Song (feat. The Piano Guys)')).toEqual(['feat. the piano guys:featured']);
    expect(kinds('Song (with Live Nation)')).toEqual(['with live nation:featured']);
  });

  it('reads a soundtrack credit as packaging unless it names a performance', () => {
    expect(kinds('Let It Go (From "Frozen")')).toEqual(['from "frozen":packaging']);
    expect(kinds('Song (From The Hunger Games: Mockingjay Part 1)')).toEqual(['from the hunger games: mockingjay part 1:packaging']);
    expect(kinds('Live and Let Die (From "Live and Let Die")')).toEqual(['from "live and let die":packaging']);
    expect(kinds('Song (From Live at Wembley)')).toEqual(['from live at wembley:version']);
  });

  it('keeps an unlisted word in brackets as a subtitle, and an unlisted label after a dash as a label', () => {
    expect(kinds('X (Glee Cast Version)')).toEqual(['glee cast version:unlisted']);
    expect(kinds('X (A COLORS SHOW)')).toEqual(['a colors show:unlisted']);
    expect(kinds('X - A COLORS SHOW')).toEqual(['a colors show:label']);
    expect(kinds('X - Gigamesh Radio Edit')).toEqual(['gigamesh radio edit:version']); // a named edit is a version
    expect(kinds('Sunflower - Spider-Man: Into the Spider-Verse')).toEqual(['spider-man: into the spider-verse:label']);
  });

  it('splits a dash tail at " / " and reads each part', () => {
    expect(kinds('My Girl - Single Version / Stereo')).toEqual(['single version:cut', 'stereo:packaging']);
  });

  it('splits the title the way songKey does and a little further: en dashes, wide brackets, nesting, a bare "feat."', () => {
    expect(parseTitle(`Song ${EN_DASH} Remastered 2011`)).toMatchObject({ base: 'song', tags: [{ kind: 'packaging' }] });
    expect(parseTitle('Song（Remastered）')).toMatchObject({ base: 'song', tags: [{ kind: 'packaging' }] });
    expect(parseTitle('Song (feat. X (Y))')).toMatchObject({ base: 'song', tags: [{ kind: 'featured' }] });
    expect(parseTitle('Song feat. Y')).toMatchObject({ base: 'song', tags: [{ text: 'feat. y', kind: 'featured' }] });
  });

  it('keeps a leading bracket as part of the title, and reads a title that is only a tag as that word', () => {
    expect(parseTitle("(Don't Fear) The Reaper")).toEqual({ base: 'dont fear the reaper', tags: [] });
    expect(parseTitle("  (Don't Fear) The Reaper ").base).toBe('dont fear the reaper');
    expect(parseTitle("(I Can't Get No) Satisfaction").tags).toEqual([]);
    expect(parseTitle('(Intro)')).toEqual({ base: 'intro', tags: [] });
    expect(parseTitle('[Interlude]').base).toBe('interlude');
  });

  it('folds the base title: case, accents on Latin letters, curly quotes and punctuation, but not marks on other scripts', () => {
    expect(parseTitle('Don’t Look Back in Anger (Remastered)').base).toBe('dont look back in anger');
    expect(parseTitle("Don't Stop Believin'").base).toBe(parseTitle('Dont Stop Believin').base);
    expect(parseTitle('Song!').base).toBe(parseTitle('Song！').base); // a full-width "!"
    expect(parseTitle('Song 3.5').base).not.toBe(parseTitle('Song 35').base);
    expect(parseTitle('?').base).not.toBe(parseTitle('!').base);
    expect(parseTitle('Beyoncé - Halo').base).toBe('beyonce');
    expect(parseTitle('Hey Ya!').base).toBe(parseTitle('Hey Ya').base);
    expect(parseTitle('Mr. Brightside').base).toBe(parseTitle('Mr Brightside').base);
    expect(parseTitle('Rock & Roll').base).toBe(parseTitle('Rock and Roll').base);
    expect(parseTitle('てんき').base).not.toBe(parseTitle('でんき').base);
    expect(parseTitle('Все').base).not.toBe(parseTitle('Всё').base);
  });
});

describe('groupListings: the same recording listed many times', () => {
  it('merges five listings of one ISRC into one song, named after the listing played most', () => {
    const listings = [
      listing('Burning Blue', 'Mariah the Scientist', 206, 'XX0000000001', 7),
      listing('Burning Blue', 'Mariah the Scientist', 206, 'XX0000000001', 3),
      listing('Burning Blue', 'Mariah the Scientist', 206, 'XX0000000001', 20),
      listing('Burning Blue', 'Mariah the Scientist', 206, 'XX0000000001', 21),
      listing('Burning Blue', 'Mariah the Scientist', 206, 'XX0000000001', 22),
    ];
    const songs = songsOf(...listings);
    expect(songs).toHaveLength(1);
    expect(songs[0]!.anchor.playRank).toBe(3);
    expect(songs[0]!.members.map((m) => m.basis)).toEqual(['anchor', 'isrc', 'isrc', 'isrc', 'isrc']);
  });

  it('still merges them without ISRC, by title, artists and length', () => {
    const songs = songsOf(...Array.from({ length: 5 }, () => listing('Burning Blue', 'Mariah the Scientist', 206)));
    expect(songs).toHaveLength(1);
    expect(songs[0]!.members.slice(1).every((m) => m.basis === 'names+length')).toBe(true);
  });

  it('merges one recording registered under two ISRCs (same title, artists and length)', () => {
    const songs = songsOf(
      listing('MUTT', 'Leon Thomas', 193.2, 'XX0000000025'),
      listing('MUTT', 'Leon Thomas', 193.2, 'XX0000000027'),
      listing('MUTT', 'Leon Thomas', 193.2, 'XX0000000025'),
      listing('MUTT', 'Leon Thomas', 193.2, 'XX0000000027'),
    );
    expect(songs).toHaveLength(1);
    expect(songs[0]!.members.map((m) => m.basis)).toEqual(['anchor', 'names+length', 'isrc', 'isrc']);
  });

  it('keeps remixes, live takes and a COLORS session apart from the original (Folded)', () => {
    const songs = songsOf(
      listing('Folded', 'Kehlani', 238, 'XX0000000010'),
      listing('Folded', 'Kehlani', 238, 'XX0000000010'),
      listing('Folded', 'Kehlani', 238, 'XX0000000010'),
      listing('Folded - A COLORS SHOW', ['Kehlani', 'COLORS'], 261, 'XX0000000011'),
      listing('Folded (Remix) [feat. Ne-Yo]', ['Kehlani', 'Ne-Yo'], 274, 'XX0000000012'),
      listing('Folded (Live) - Spotify Live Room', 'Kehlani', 242, 'XX0000000013'),
    );
    expect(songs).toHaveLength(4);
    expect(songs[0]!.members).toHaveLength(3);
    expect(songs.slice(1).map((s) => s.versionTags)).toEqual([[], ['remix'], ['live', 'spotify live room']]);
    expect(listingProfile(songs[1]!.anchor).labels).toEqual(['a colors show']);
  });

  it('merges an album and five compilations of one song, and keeps its live, Unplugged and feat. versions apart', () => {
    const songs = songsOf(
      listing('Tear in My Heart', 'Twenty One Pilots', 188, 'XX0000000020'),
      ...Array.from({ length: 5 }, () => listing('Tear in My Heart', 'Twenty One Pilots', 188, 'XX0000000020')),
      listing('Tear In My Heart - Live in Mexico City', 'Twenty One Pilots', 202, 'XX0000000021'),
      listing('Tear in My Heart - MTV Unplugged Live', 'Twenty One Pilots', 282, 'XX0000000022'),
      listing('Tear in My Heart (feat. MUTEMATH)', ['Twenty One Pilots', 'Mutemath'], 229, 'XX0000000023'),
    );
    expect(songs.map((s) => s.members.length)).toEqual([6, 1, 1, 1]);
  });
});

describe('groupListings: Cooler Than Me, where the title alone cannot tell the versions apart', () => {
  const posner = 'Mike Posner';
  const library = () => [
    listing('Cooler Than Me - Single Mix', [posner, 'Gigamesh'], 213, 'XX0000000030'),
    listing('Cooler Than Me - Single Mix', [posner, 'Gigamesh'], 213, 'XX0000000030'),
    listing('Cooler Than Me - Single Mix', [posner, 'Gigamesh'], 213, 'XX0000000030'),
    listing('Cooler Than Me - Gigamesh Remix', posner, 232, 'XX0000000031'),
    listing('Cooler Than Me - Gigamesh Radio Edit', [posner, 'Gigamesh'], 274, 'XX0000000032'),
    listing('Cooler Than Me (feat. Big Sean)', [posner, 'Big Sean'], 228, 'XX0000000033'),
    listing('Cooler Than Me', [posner, 'Big Sean'], 225, 'XX0000000034'),
    listing('Cooler Than Me', [posner, 'Getter'], 196, 'XX0000000035'),
    listing('Cooler Than Me', [posner, 'Deorro'], 192, 'XX0000000036'),
  ];

  it('merges the single-mix listings and the two Big Sean listings; the remixes stay separate', () => {
    const { songs } = groupListings(library());
    expect(songs).toHaveLength(6);
    expect(songs.map((s) => s.members.length).sort()).toEqual([1, 1, 1, 1, 2, 3]);
    const bigSean = songs.find((s) => s.members.length === 2)!;
    expect(bigSean.members.map((m) => m.track.title)).toEqual(expect.arrayContaining(['Cooler Than Me (feat. Big Sean)', 'Cooler Than Me']));
    expect(bigSean.members[1]!.basis).toBe('names+length');
  });

  it('keeps the Gigamesh Radio Edit apart from the Single Mix: a named edit is a different version', () => {
    const { songs } = groupListings(library());
    const single = songs.find((s) => s.anchor.title.includes('Single Mix'))!;
    expect(single.members).toHaveLength(3);
    const radio = songs.find((s) => s.anchor.title.includes('Radio Edit'))!;
    expect(radio.members).toHaveLength(1);
    expect(radio.versionTags).toEqual(['gigamesh radio edit']);
  });

  it('tells the 2025 Getter and Deorro remixes from the original by their credited artists, with no tag in the title', () => {
    const { songs } = groupListings(library());
    const alone = songs.filter((s) => s.members.length === 1 && s.anchor.title === 'Cooler Than Me');
    expect(alone.map((s) => s.anchor.artists!.map((a) => a.name))).toEqual([['Mike Posner', 'Getter'], ['Mike Posner', 'Deorro']]);
  });
});

describe('groupListings: tags and length', () => {
  it('keeps studio-processed copies apart, however close their length', () => {
    expect(songsOf(listing('Mutt', 'Leon Thomas', 193, 'XX0000000040'), listing('Mutt (Chopped and Screwed)', 'Leon Thomas', 193, 'XX0000000041'), listing('Mutt - Sped Up', 'Leon Thomas', 193, 'XX0000000042'))).toHaveLength(3);
  });

  it('keeps apart a version with the original recording\'s length, whichever way its tag is spelled', () => {
    for (const tag of ['(A Capella)', '(Acappella)', '(Eng Ver.)', '(Jpn Ver.)', '(Spanish)', '(Bass Boosted)', '(Reverbed)', '(16D Audio)', '- Ao Vivo', '(En Vivo)', '(Kygo Edit)', '(Take 2)', '(Part VI)', '- Some Label']) {
      expect(songsOf(listing('Song', 'Artist', 213), listing(`Song ${tag}`, 'Artist', 214)), tag).toHaveLength(2);
    }
  });

  it('merges packaging tags: a remaster, and a re-recording (which has its own length)', () => {
    const songs = songsOf(
      listing('Halo', 'Beyonce', 261),
      listing('Halo - Remastered 2011', 'Beyonce', 262),
      listing('Love Story', 'Taylor Swift', 235),
      listing("Love Story (Taylor's Version)", 'Taylor Swift', 245),
    );
    expect(titlesOf(songs)).toEqual([['Halo', 'Halo - Remastered 2011'], ['Love Story', "Love Story (Taylor's Version)"]]);
    expect(songs[1]!.members[1]).toMatchObject({ basis: 'packaging', lengthGapS: 10 });
  });

  it('lets a cut tag explain a long gap against the plain title, with or without a shared subtitle', () => {
    const songs = songsOf(listing('Song', 'Artist', 250), listing('Song - Radio Edit', 'Artist', 210));
    expect(titlesOf(songs)).toEqual([['Song', 'Song - Radio Edit']]);
    expect(songs[0]!.members[1]).toMatchObject({ basis: 'packaging', lengthGapS: 40 });
    expect(songsOf(listing("Don't You (Forget About Me)", 'Simple Minds', 260), listing("Don't You (Forget About Me) - Radio Edit", 'Simple Minds', 230))).toHaveLength(1);
    expect(songsOf(listing('Song (Subtitle)', 'Artist', 200), listing("Song (Subtitle) (Taylor's Version)", 'Artist', 215))).toHaveLength(1);
    expect(songsOf(listing('Song (Subtitle)', 'Artist', 200), listing('Song - Radio Edit', 'Artist', 150))).toHaveLength(2);
  });

  it('takes a canonical-version tag (original mix, album version) as the plain song, so a radio edit joins it', () => {
    expect(songsOf(listing('Song (Original Mix)', 'Artist', 400), listing('Song (Radio Edit)', 'Artist', 200))).toHaveLength(1);
    expect(songsOf(listing('Song - Album Version', 'Artist', 260), listing('Song - Radio Edit', 'Artist', 200))).toHaveLength(1);
  });

  it('takes any spelling of a shortened cut as a cut', () => {
    for (const tag of ['Short Edit', 'Video Edit', 'Edit', 'UK Radio Edit', 'Radio Cut']) {
      expect(songsOf(listing('Song', 'Artist', 260), listing(`Song (${tag})`, 'Artist', 200)), tag).toHaveLength(1);
    }
  });

  it('does not let one cut explain another: the anchor is a cut, so a different cut of different length stays apart', () => {
    const songs = songsOf(listing('Song - Single Mix', 'Artist', 213), listing('Song - Radio Edit', 'Artist', 200));
    expect(titlesOf(songs)).toEqual([['Song - Single Mix'], ['Song - Radio Edit']]);
  });

  it('ignores a bracketed subtitle and lets length decide', () => {
    expect(songsOf(listing('Back To Life (However Do You Want Me)', 'Soul II Soul', 213), listing('Back To Life', 'Soul II Soul', 213))).toHaveLength(1);
    expect(songsOf(listing('Folded', 'Kehlani', 238), listing('Folded (A COLORS SHOW)', 'Kehlani', 261))).toHaveLength(2);
    expect(songsOf(listing('Folded', 'Kehlani', 238), listing('Folded (A COLORS SHOW)', 'Kehlani', 239))).toHaveLength(1);
  });

  it('takes another edit within 10 s only when the titles match exactly', () => {
    const exact = songsOf(listing('Song', 'Artist', 200), listing('Song', 'Artist', 206));
    expect(exact).toHaveLength(1);
    expect(exact[0]!.members[1]).toMatchObject({ basis: 'edit', lengthGapS: 6 });
    expect(songsOf(listing('Song (Subtitle)', 'Artist', 200), listing('Song', 'Artist', 206))).toHaveLength(2);
    expect(songsOf(listing('Halo', 'Beyonce', 200), listing('Halo - Digitally Remastered', 'Beyonce', 206))).toHaveLength(1);
  });

  it('draws the lines at exactly 4 s, 10 s and 60 s, in whole milliseconds', () => {
    expect([SAME_RECORDING_S, SAME_SONG_S, MIN_SONG_S]).toEqual([4, 10, 60]);
    const at = (a: number, b: number, titleB = 'Song') => groupListings([listing('Song', 'Artist', a / 1000), listing(titleB, 'Artist', b / 1000)]).songs;
    expect(at(124_002, 128_002)).toHaveLength(1); // 4.000 s apart is one recording
    expect(at(124_002, 128_002)[0]!.members[1]!.basis).toBe('names+length');
    expect(at(124_000, 128_001)[0]!.members[1]!.basis).toBe('edit'); // 4.001 s is another edit
    expect(at(118_002, 128_002)).toHaveLength(1); // 10.000 s apart, same title: another edit
    expect(at(118_000, 128_001)).toHaveLength(2); // 10.001 s apart
    expect(groupListings([listing('Song', 'Artist', 60)]).dropped).toHaveLength(0);
    expect(groupListings([listing('Song', 'Artist', 59.999)]).dropped).toHaveLength(1);
  });

  it('reports the gap in seconds without rounding it away', () => {
    const songs = songsOf(listing('Song', 'Artist', 200, 'XX0000000001'), listing('Song', 'Artist', 210.04, 'XX0000000001'));
    expect(songs[0]!.members[1]!.lengthGapS).toBeCloseTo(10.04, 5);
  });

  it('keeps covers apart: same title and length, different credited artists', () => {
    expect(songsOf(listing('Hallelujah', 'Leonard Cohen', 273), listing('Hallelujah', 'Jeff Buckley', 273))).toHaveLength(2);
  });

  it('names no song from a generic title: only ISRC joins two "Intro" tracks, however it is written', () => {
    for (const title of ['Intro', '(Intro)', '[Interlude]', 'Overture', 'Track 1', 'Untitled']) {
      expect(songsOf(listing(title, 'Artist', 90, 'XX0000000050'), listing(title, 'Artist', 91, 'XX0000000051')), title).toHaveLength(2);
    }
    expect(songsOf(listing('Intro', 'Artist', 90, 'XX0000000050'), listing('Intro', 'Artist', 90, 'XX0000000050'))).toHaveLength(1);
  });

  it('does not let a different-length snippet or a hidden version join a song, and says why they were left out', () => {
    const { songs, dropped } = groupListings([
      listing('Thriller', 'Michael Jackson', 357),
      listing('Thriller (Instrumental)', 'Michael Jackson', 355),
      listing('Burning Blue', 'Mariah the Scientist', 55, 'XX0000000080'),
    ]);
    expect(songs).toHaveLength(1);
    expect(dropped.map((d) => d.reason).sort()).toEqual(['little-singing', 'snippet']);
  });
});

describe('groupListings: guests and credited artists', () => {
  it('treats featured guests the same whether or not the title names them', () => {
    expect(songsOf(listing('Latch', 'Disclosure', 255), listing('Latch (feat. Sam Smith)', ['Disclosure', 'Sam Smith'], 255))).toHaveLength(1);
    expect(songsOf(listing('Cooler Than Me (feat. Big Sean)', ['Mike Posner', 'Big Sean'], 228), listing('Cooler Than Me', ['Mike Posner', 'Big Sean'], 227))).toHaveLength(1);
  });

  it('keeps apart two titles that name different guests', () => {
    expect(songsOf(listing('Song (feat. B)', ['A', 'B'], 200), listing('Song (feat. C)', ['A', 'C'], 201))).toHaveLength(2);
  });

  it('finds a guest by the credited name, whatever its punctuation: "Tyler, The Creator", "Hall & Oates", "Jay Z"', () => {
    expect(songsOf(listing('Song (feat. Tyler, The Creator)', ['X', 'Tyler, The Creator'], 200), listing('Song', 'X', 200))).toHaveLength(1);
    expect(songsOf(listing('Song (feat. Hall & Oates)', ['X', 'Hall & Oates'], 200), listing('Song', 'X', 200))).toHaveLength(1);
    expect(songsOf(listing('Song (feat. Jay Z)', ['X', 'JAY-Z'], 200), listing('Song', 'X', 200))).toHaveLength(1);
    expect(songsOf(listing('Song (feat. The Piano Guys)', ['X', 'The Piano Guys'], 200), listing('Song', ['X', 'The Piano Guys'], 200))).toHaveLength(1);
  });

  it('reads a bare "feat." and a leading bracket, and ignores punctuation, in the title', () => {
    expect(songsOf(listing('Song feat. Y', ['A', 'Y'], 200), listing('Song', 'A', 200))).toHaveLength(1);
    expect(songsOf(listing("(Don't Fear) The Reaper", 'Blue Oyster Cult', 308), listing("Don't Fear The Reaper", 'Blue Oyster Cult', 308))).toHaveLength(1);
    expect(songsOf(listing('Hey Ya!', 'Outkast', 235), listing('Hey Ya', 'Outkast', 235))).toHaveLength(1);
    expect(songsOf(listing(`Song ${EN_DASH} Remastered 2011`, 'Artist', 200), listing('Song', 'Artist', 200))).toHaveLength(1);
  });

  it('does not merge titles that differ only by a mark on a non-Latin letter', () => {
    expect(songsOf(listing('てんき', 'Artist', 200), listing('でんき', 'Artist', 201))).toHaveLength(2);
    expect(songsOf(listing('Все', 'Artist', 200), listing('Всё', 'Artist', 201))).toHaveLength(2);
  });
});

describe('groupListings: ISRC and its limits', () => {
  it('does not let one ISRC join a remix to its original', () => {
    expect(songsOf(listing('MUTT', 'Leon Thomas', 193, 'XX0000000060'), listing('MUTT (Remix)', 'Leon Thomas', 193, 'XX0000000060'))).toHaveLength(2);
  });

  it('lets ISRC chain but never lets a length chain: a third listing is checked against the anchor only', () => {
    const songs = songsOf(listing('Song', 'Artist', 200, 'XX0000000070'), listing('Song', 'Artist', 215, 'XX0000000070'), listing('Song', 'Artist', 218));
    expect(songs.map((s) => s.members.length)).toEqual([2, 1]);
    expect(songs[0]!.members[1]).toMatchObject({ basis: 'isrc', lengthGapS: 15 });
  });

  it('trusts an ISRC even when the titles differ (a punctuation difference, or a reused ISRC the audit lists)', () => {
    expect(songsOf(listing('Wonderwall', 'Oasis', 258, 'XX0000000071'), listing("Don't Look Back in Anger", 'Oasis', 288, 'XX0000000071'))).toHaveLength(1);
  });
});

describe('groupListings: stability and missing details', () => {
  it('names a song after its most-played listing and gives the same groups whatever order the listings arrive in', () => {
    const list = [
      listing('Song', 'Artist', 200, 'XX0000000090', 5),
      listing('Song', 'Artist', 200, 'XX0000000090', 2),
      listing('Other', 'Artist', 180, 'XX0000000091', 1),
      listing('Song', 'Artist', 201, undefined, 9),
    ];
    const a = groupListings(list).songs.map((s) => [s.anchor.id, s.members.map((m) => m.track.id)]);
    const b = groupListings([...list].reverse()).songs.map((s) => [s.anchor.id, s.members.map((m) => m.track.id)]);
    expect(a).toEqual(b);
    expect(groupListings(list).songs.map((s) => s.anchor.playRank)).toEqual([1, 2]);
  });

  it('breaks a play-rank tie by track id, so the anchor never depends on arrival order', () => {
    const [x, y] = [{ ...listing('Song', 'Artist', 200, 'XX0000000092', 4), id: 'b-later' }, { ...listing('Song', 'Artist', 200, 'XX0000000092', 4), id: 'a-first' }];
    const anchor = (order: Track[]) => groupListings(order).songs[0]!.anchor.id;
    expect(anchor([x, y])).toBe('a-first');
    expect(anchor([y, x])).toBe('a-first');
  });

  it('makes each listing its own song when ISRC, length and credited artists were not read (tracks cached before they were)', () => {
    const plain = (n: number): Track => ({ id: `t${n}`, title: 'Song', artist: 'Artist', artistId: 'a', spotifyUrl: '', playRank: n });
    expect(groupListings([plain(0), plain(1), plain(2)]).songs).toHaveLength(3);
  });
});

describe('listing details', () => {
  it('profiles a listing: base, version tags, guests, credited artists, length and ISRC', () => {
    const p = listingProfile(listing('Folded (Remix) [feat. Ne-Yo]', ['Kehlani', 'Ne-Yo'], 274, 'XX0000000012'));
    expect(p).toMatchObject({ base: 'folded', versions: ['remix'], mentions: [' ne yo '], ms: 274_000, isrc: 'XX0000000012' });
    expect(p.credited.map((c) => c.name)).toEqual(['kehlani', 'ne yo']);
  });

  it('removes ISRC, length and credited artists before a track leaves the server, and returns a bare track as it is', () => {
    const full = listing('Song', ['A', 'B'], 200, 'XX0000000099');
    const bare = withoutListingDetails(full);
    expect(bare).not.toHaveProperty('isrc');
    expect(bare).not.toHaveProperty('durationMs');
    expect(bare).not.toHaveProperty('artists');
    expect(bare).toMatchObject({ id: full.id, title: 'Song', artist: 'A' });
    expect(withoutListingDetails(bare)).toBe(bare);
    for (const only of [{ isrc: 'XX0000000099' }, { durationMs: 200_000 }, { artists: [{ id: 'a', name: 'A' }] }]) {
      const one = withoutListingDetails({ ...bare, ...only });
      expect(Object.keys(one).sort(), JSON.stringify(only)).toEqual(Object.keys(bare).sort());
    }
  });
});

describe('groupListings: round two of the review', () => {
  it('lets an equal ISRC join listings whose dash labels differ, but keeps an unlisted dash label apart without one', () => {
    const [a, b] = [listing('Sunflower - Spider-Man: Into the Spider-Verse', ['Post Malone', 'Swae Lee'], 158, 'XX0000000101'), listing('Sunflower (with Swae Lee)', ['Post Malone', 'Swae Lee'], 158, 'XX0000000101')];
    expect(groupListings([a, b]).songs).toHaveLength(1);
    expect(songsOf({ ...a, isrc: undefined }, { ...b, isrc: undefined })).toHaveLength(2);
  });

  it('reads the real spellings of a cut, a remaster and a re-recording', () => {
    for (const tag of ['Original Radio Edit', 'Clean Edit', '7" Mix', '7-Inch Version', 'Re-Recording', 'New Recording']) expect(kindsOf(`Song (${tag})`), tag).toEqual(['cut']);
    for (const tag of ['2001 Stereo Mix', 'Re-Mastered', '2015 Paisley Park Remaster', 'Original Recording Remastered', 'Limited Edition', '25th Anniversary Edition', 'Single', 'Album', 'EP']) {
      expect(kindsOf(`Song - ${tag}`), tag).toEqual(['packaging']);
    }
    expect(songsOf(listing("Summer of '69", 'Bryan Adams', 260), listing("Summer of '69 (Re-Recording)", 'Bryan Adams', 245))).toHaveLength(1);
    expect(kindsOf('Song (Re-Recorded Live)')).toEqual(['version']);
  });

  it('takes "Live" and "Live Version", "Pt. 2" and "Part 2", "Sped Up" and "Sped Up Version", "Remix" and "Remixed", "Spanish" and "Spanish Version" as one tag', () => {
    for (const [x, y] of [['Live', 'Live Version'], ['Pt. 2', 'Part 2'], ['Sped Up', 'Sped-Up Version'], ['Remix', 'Remixed'], ['Spanish', 'Spanish Version'], ['Acoustic', 'Acoustic Version']]) {
      expect(songsOf(listing(`Song (${x})`, 'Artist', 213, 'XX0000000102'), listing(`Song (${y})`, 'Artist', 213, 'XX0000000103')), `${x} / ${y}`).toHaveLength(1);
      expect(songsOf(listing(`Song (${x})`, 'Artist', 213), listing(`Song (${y})`, 'Artist', 214)), `${x} / ${y} without ISRC`).toHaveLength(1);
    }
    expect(songsOf(listing('Song (Live)', 'Artist', 213), listing('Song (Live at Wembley)', 'Artist', 213))).toHaveLength(2);
  });

  it('reads a K-drama soundtrack part as a soundtrack credit, not a version', () => {
    expect(kinds('Stay With Me (Goblin OST Part.1)')).toEqual(['goblin ost part.1:packaging']);
    expect(songsOf(listing('Stay With Me (Goblin OST Part.1)', 'Punch', 200, 'XX0000000104'), listing('Stay With Me', 'Punch', 200, 'XX0000000104'))).toHaveLength(1);
    expect(kindsOf('Song (Part 2)')).toEqual(['version']);
  });

  it('does not read a version word in a quoted film title: Theme from "Live and Let Die", From "The Karate Kid Part II"', () => {
    expect(kinds('Live and Let Die (Theme from "Live and Let Die")')).toEqual(['theme from "live and let die":packaging']);
    expect(kinds('Glory of Love (Theme from "The Karate Kid Part II")')).toEqual(['theme from "the karate kid part ii":packaging']);
    expect(kinds('Song (From the Live-Action Film "Cinderella")')).toEqual(['from the live-action film "cinderella":packaging']);
    expect(kinds('Song (From Live at Wembley)')).toEqual(['from live at wembley:version']);
  });

  it('reads more language and reinterpretation tags as versions', () => {
    for (const tag of ['Versión en Español', 'Español', 'Version Française', 'Deutsch', 'Reimagined', 'Refix', 'Concert Version', 'In English']) {
      expect(kindsOf(`Song (${tag})`), tag).toContain('version');
    }
  });

  it('sets a guest aside whether or not the other title names it, and whatever the spelling of "and"', () => {
    expect(songsOf(listing('Song (feat. Guest)', 'Lead', 200), listing('Song', ['Lead', 'Guest'], 200))).toHaveLength(1);
    expect(songsOf(listing('Song (feat. Hall & Oates)', ['X', 'Hall & Oates'], 200), listing('Song (feat. Hall and Oates)', ['X', 'Hall & Oates'], 200))).toHaveLength(1);
    expect(songsOf(listing('Song (feat. Jay-Z & Beyoncé)', ['X', 'JAY-Z', 'Beyoncé'], 200), listing('Song (feat. Beyoncé & Jay-Z)', ['X', 'JAY-Z', 'Beyoncé'], 200))).toHaveLength(1);
    expect(songsOf(listing('Song (feat. B)', ['A', 'B'], 200), listing('Song (feat. C)', ['A', 'C'], 201))).toHaveLength(2);
  });

  it('does not read a remix as a guest, or "Ft." inside a title as a "feat."', () => {
    expect(kinds('Song (feat. B Remix)')).toEqual(['feat. b remix:version']);
    expect(songsOf(listing('Song (feat. B Remix)', ['A', 'B'], 220), listing('Song', 'A', 220))).toHaveLength(2);
    expect(parseTitle('Welcome to Ft. Lauderdale')).toEqual({ base: 'welcome to ft lauderdale', tags: [] });
  });

  it('does not let a cut tag explain a gap that is no cut: a 61 s "radio edit" is not a 400 s song', () => {
    expect(songsOf(listing('Song', 'Artist', 400), listing('Song (Radio Edit)', 'Artist', 61))).toHaveLength(2);
    expect(songsOf(listing('Song', 'Artist', 400), listing('Song (Radio Edit)', 'Artist', 200))).toHaveLength(1);
  });

  it('does not merge titles made only of punctuation, or that differ only by a decimal', () => {
    expect(songsOf(listing('?', 'Artist', 200), listing('!', 'Artist', 200), listing('...', 'Artist', 201))).toHaveLength(3);
    expect(songsOf(listing('Song 3.5', 'Artist', 200), listing('Song 35', 'Artist', 201))).toHaveLength(2);
  });

  it('treats a missing, zero or not-a-number length as unknown, not as a snippet', () => {
    for (const durationMs of [0, NaN, -5, undefined]) {
      const { songs, dropped } = groupListings([{ ...listing('Song', 'Artist', 200), durationMs } as Track]);
      expect(dropped, String(durationMs)).toHaveLength(0);
      expect(songs, String(durationMs)).toHaveLength(1);
    }
  });

  it('keeps the first listing that owns an ISRC as its owner, and reads the same tags in any order', () => {
    expect(songsOf(listing('Song (Live) (Remix)', 'A', 200, 'XX0000000105'), listing('Song (Remix) (Live)', 'A', 201, 'XX0000000106'))).toHaveLength(1);
    const songs = songsOf(listing('Song', 'A', 200, 'XX0000000107'), listing('Song', 'A', 215, 'XX0000000107'), listing('Song', 'A', 216, 'XX0000000108'));
    expect(songs.map((s) => s.members.length)).toEqual([2, 1]); // the third is 16 s from the anchor and shares no ISRC
  });
});
