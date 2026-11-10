import { describe, expect, it } from 'vitest';
import { hasLittleSinging } from '../../src/lib/songs/resolve';
import { artistLine, classifyTag, cleanTitle, foldKey, hasVersionTag } from '../../src/lib/songs/title';

const clean = (raw: string) => cleanTitle(raw).title;
const unchanged = (raw: string) => expect(cleanTitle(raw)).toEqual({ title: raw, featured: [], removed: [] });

describe('cleanTitle: the patterns the list must not show (QWW-49)', () => {
  it.each([
    ['Dreadlock Holiday (Album Version)', 'Dreadlock Holiday'],
    ['Mr. Brightside (Alternate Version)', 'Mr. Brightside'],
    ['I’m Just Ken (Short Version)', 'I’m Just Ken'],
    ['Love Story (Taylor’s Version)', 'Love Story'],
    ['Sweet Child O’ Mine [Explicit Album Version]', 'Sweet Child O’ Mine'],
    ['Where Is My Mind? (Fight Club Version)', 'Where Is My Mind?'],
    ['Duvet (TV Size Ver.)', 'Duvet'],
    ['Everytime We Touch - Single Version', 'Everytime We Touch'],
    ['Song (New Version 2017)', 'Song'],
    ['The Hobbit (Extended Cover)', 'The Hobbit'],
    ['Take Care (Guitar Cover)', 'Take Care'],
  ])('removes a "(… version)" tag: %s', (raw, shown) => {
    expect(clean(raw)).toBe(shown);
    expect(cleanTitle(raw).removed[0]!.kind).toBe('version');
  });

  it.each([
    ['Barbie Girl [DUET]', 'Barbie Girl'],
    ['Bad Touch (Duet)', 'Bad Touch'],
    ['Need You Now - Duet', 'Need You Now'],
  ])('removes a duet tag: %s', (raw, shown) => {
    expect(clean(raw)).toBe(shown);
    expect(cleanTitle(raw).removed[0]!.kind).toBe('duet');
  });

  it.each([
    ['Here Comes the Sun - Remastered 2009', 'Here Comes the Sun'],
    ['Hey Jude - 2015 Remaster', 'Hey Jude'],
    ['Imagine (Remastered)', 'Imagine'],
    ['Yesterday (2009 Digital Remaster)', 'Yesterday'],
    ['Space Oddity [Remastered 2015]', 'Space Oddity'],
  ])('removes a remaster tag, bracketed or after a dash: %s', (raw, shown) => {
    expect(clean(raw)).toBe(shown);
    expect(cleanTitle(raw).removed[0]!.kind).toBe('remaster');
  });

  it.each([
    ['Creep (Live)', 'Creep'],
    ['Back In Black (Live at Donington)', 'Back In Black'],
    ['Hells Bells (Live at River Plate)', 'Hells Bells'],
    ['Tears In Heaven (MTV Unplugged)', 'Tears In Heaven'],
    ['Wonderwall - Live', 'Wonderwall'],
    ['Hotel California (Live @ Moscow Music & Peace Festival)', 'Hotel California'],
    ['Imagine (Live 1969)', 'Imagine'],
    ['Zoo Station (Zoo TV Live from Sydney)', 'Zoo Station'],
    ['La Bamba (En Vivo)', 'La Bamba'],
    ['The Boxer (The Concert In Central Park)', 'The Boxer'],
    ['Flowers (The Backyard Sessions)', 'Flowers'],
    ['Wonderful World (Radio 1 Live Lounge)', 'Wonderful World'],
    ['Piano Man (Live in Houston)', 'Piano Man'],
    ['2 Minutes To Midnight (Live After Death)', '2 Minutes To Midnight'],
    ['Raining Blood (Live Still Reigning)', 'Raining Blood'],
  ])('removes a live tag: %s', (raw, shown) => {
    expect(clean(raw)).toBe(shown);
    expect(cleanTitle(raw).removed[0]!.kind).toBe('live');
  });

  it('takes "(feat. …)" off the title and hands the artist to the artist line', () => {
    expect(cleanTitle('Latch (feat. Sam Smith)')).toEqual({ title: 'Latch', featured: ['Sam Smith'], removed: [{ text: 'feat. Sam Smith', kind: 'feat' }] });
    expect(cleanTitle('Hold On [ft. Jess Glynne]').featured).toEqual(['Jess Glynne']);
    expect(cleanTitle('Stan (featuring Dido)').featured).toEqual(['Dido']);
    expect(cleanTitle('Song - feat. Kid Ink')).toMatchObject({ title: 'Song', featured: ['Kid Ink'] });
    expect(artistLine('Disclosure', ['Sam Smith'])).toBe('Disclosure feat. Sam Smith');
  });

  it('keeps the credit when its name ends like a tag, and when a tag shares the bracket', () => {
    expect(cleanTitle('Wings (feat. Little Mix)')).toMatchObject({ title: 'Wings', featured: ['Little Mix'] });
    expect(cleanTitle('Song (feat. Skrillex Live)').featured).toEqual(['Skrillex Live']);
    expect(cleanTitle('Song (Radio Edit, feat. Drake)')).toMatchObject({ title: 'Song', featured: ['Drake'] });
    expect(cleanTitle('Song (feat. Drake, Radio Edit)')).toMatchObject({ title: 'Song', featured: ['Drake'] });
    expect(cleanTitle('Song (feat. Earth, Wind & Fire)')).toMatchObject({ title: 'Song', featured: ['Earth, Wind & Fire'] });
    expect(cleanTitle('Song (feat. A / B, Live)')).toMatchObject({ title: 'Song', featured: ['A / B'] });
  });

  it('keeps "feat." in the artist line and does not add it twice', () => {
    expect(artistLine('Alan Jackson feat. Jimmy Buffett', ['Jimmy Buffett'])).toBe('Alan Jackson feat. Jimmy Buffett');
    expect(artistLine('David Guetta feat. Nicki Minaj & Flo Rida', ['Nicki Minaj & Flo Rida'])).toBe('David Guetta feat. Nicki Minaj & Flo Rida');
    expect(artistLine('David Guetta, Nicki Minaj, Flo Rida', ['Nicki Minaj & Flo Rida'])).toBe('David Guetta, Nicki Minaj, Flo Rida');
    expect(artistLine('A feat. B & C', ['C & B'])).toBe('A feat. B & C');
    expect(artistLine('Mark Ronson feat. Bruno Mars', ['Kevin Parker'])).toBe('Mark Ronson feat. Bruno Mars & Kevin Parker');
    expect(artistLine('Aqua', [])).toBe('Aqua');
    expect(artistLine('Artist', ['A', 'A'])).toBe('Artist feat. A');
  });

  it('adds a featured artist whose name sits inside the artist line by letters but is not credited there', () => {
    // from the catalogue: "My Love (feat. T.I.)" by Justin Timberlake; "ti" is inside "justintimberlake"
    expect(artistLine('Justin Timberlake', ['T.I.'])).toBe('Justin Timberlake feat. T.I.');
    expect(artistLine('Steve Aoki', ['Eve'])).toBe('Steve Aoki feat. Eve');
    expect(artistLine('Cheryl', ['Cher'])).toBe('Cheryl feat. Cher');
    expect(artistLine('Tyga', ['YG'])).toBe('Tyga feat. YG');
  });

  it('does not read the artist inside a remix credit as a featured artist', () => {
    const c = cleanTitle('Creep (Gamper & Dadoni feat. Ember Island Remix)');
    expect(c.title).toBe('Creep');
    expect(c.featured).toEqual([]);
    expect(c.removed[0]!.kind).toBe('remix');
  });

  it.each([
    ["L'amour toujours (Radio Edit)", "L'amour toujours", 'edit'],
    ['Waiting For Love (Original Mix)', 'Waiting For Love', 'edit'],
    ['Infinity 2008 (Klaas Vocal Edit)', 'Infinity 2008', 'edit'],
    ['Song (Radio Edit 2011)', 'Song', 'edit'],
    ['Waves (Robin Schulz Remix)', 'Waves', 'remix'],
    ['Song (Dance-Remix 2003)', 'Song', 'remix'],
    ['Song (Fatboy Slim Latin Ska Acid Breakbeat Remix)', 'Song', 'remix'],
    ['Safe And Sound (Jimmy Ahlander’s Twist)', 'Safe And Sound', 'remix'],
    ['Check Yo Self (Remix)', 'Check Yo Self', 'remix'],
    ['Thunderstruck (DJs From Mars Bootleg)', 'Thunderstruck', 'remix'],
    ['Duvet (TV)', 'Duvet', 'tv'],
    ['Voulez-vous (Lyric Video)', 'Voulez-vous', 'video'],
    ['Kids (Fanmade Video)', 'Kids', 'video'],
    ['Song (Acoustic)', 'Song', 'edition'],
    ['Song (Deluxe Edition)', 'Song', 'edition'],
    ['Song (Stripped)', 'Song', 'edition'],
    ['Faded (Restrung)', 'Faded', 'edition'],
    ['Song (2008 Re-record)', 'Song', 'edition'],
    ['Let It Go (From "Frozen")', 'Let It Go', 'context'],
    ['Falling Slowly (Once OST)', 'Falling Slowly', 'context'],
    ['My Life Is Going On (La Casa De Papel Opening)', 'My Life Is Going On', 'context'],
    ['Pump-Pump (ESC 1976 Finland)', 'Pump-Pump', 'context'],
    ['Run Away (ESC 2010 Moldova Live)', 'Run Away', 'context'],
  ])('removes the other tags a source adds: %s', (raw, shown, kind) => {
    expect(clean(raw)).toBe(shown);
    expect(cleanTitle(raw).removed[0]!.kind).toBe(kind);
  });

  it('removes every tag, wherever it sits, and tidies what is left', () => {
    expect(clean('Song (Live) [Remastered 2011]')).toBe('Song');
    expect(clean('Song (Radio Edit) (feat. X)')).toBe('Song');
    expect(clean('Boom Boom  Pow (Explicit Version)')).toBe('Boom Boom Pow');
    expect(clean('Song - Live - Remastered 2011')).toBe('Song');
    expect(clean('Song (Single Version, Remastered)')).toBe('Song');
    expect(clean('Song (Radio Edit / Clean)')).toBe('Song');
    expect(clean('Song [Live] (Album Version) - Remastered')).toBe('Song');
  });

  it('is its own fixed point: cleaning a clean title removes nothing, nested tags included', () => {
    for (const raw of ['Song (Live (Remastered))', 'Song (Radio Edit) - Live', 'Song [DUET] (feat. X) (Album Version)', 'Song - Remastered 2011 - Single Version']) {
      const once = cleanTitle(raw).title;
      expect(cleanTitle(once).removed).toEqual([]);
      expect(once).toBe('Song');
    }
  });

  it('leaves the title as it was, the same text, when nothing came off', () => {
    const raw = 'Plain  Title ';
    expect(cleanTitle(raw)).toEqual({ title: raw, featured: [], removed: [] });
  });

  it('never leaves an empty title, or one of only punctuation', () => {
    for (const raw of ['(Live)', '[DUET]', '((Live))', '(((Live)))']) expect(clean(raw)).toBe(raw);
    expect(clean('Song ((Live))')).toBe('Song'); // the bracket a tag leaves empty goes with it
  });

  it('changes only what a tag was: the rest of the title keeps its own punctuation and spacing', () => {
    expect(clean('-30- (Live)')).toBe('-30-');
    expect(clean('Attention : danger (Live)')).toBe('Attention : danger');
    expect(clean('Hero - (TV Size)')).toBe('Hero');
  });

  it('is quick on garbage: a title past any real length is left alone', () => {
    const long = 'a'.repeat(100_000) + ' (Live)';
    const t0 = Date.now();
    expect(cleanTitle(long).title).toBe(long);
    expect(cleanTitle('(' + ' '.repeat(100_000) + 'x)').removed).toEqual([]);
    expect(foldKey('a'.repeat(100_000), 'Title')).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

// Real titles from the catalogue whose brackets or words look like a tag and are not. A change here
// turns one song into another, so each stays exactly as written.
describe('cleanTitle: real titles that are not tags stay as they are', () => {
  it.each([
    ["(I Can't Get No) Satisfaction", 'The Rolling Stones, a bracket at the start'],
    ['Sweet Dreams (Are Made of This)', 'Eurythmics, the bracket is the rest of the title'],
    ['Running Up That Hill (A Deal With God)', 'Kate Bush; "with" is in the bracket'],
    ['Come Out And Play (Keep ’em Separated)', 'The Offspring'],
    ['(You Gotta) Fight For Your Right (To Party!)', 'Beastie Boys, two real brackets'],
    ['Gimme! Gimme! Gimme! (A Man After Midnight)', 'ABBA'],
    ['Right Now (Na Na Na)', 'Akon'],
    ["I'm Gonna Be (500 Miles)", 'The Proclaimers'],
    ['The Time (Dirty Bit)', 'The Black Eyed Peas'],
    ['Time Of Your Life (Good Riddance)', 'Green Day'],
    ['Maria (I Like It Loud)', 'Scooter'],
    ['Das geht ab! (Wir feiern die ganze Nacht)', 'Die Atzen'],
    ['Rocket Man (I Think It’s Going to Be a Long Long Time)', 'Elton John'],
    ['Everybody (Backstreet’s Back)', 'Backstreet Boys'],
    ['Heatwave (Love Is Like A Heatwave)', 'Martha Reeves and the Vandellas, as the catalogue spells it'],
    ['(I’ve Had) The Time Of My Life', 'a bracket at the start, from the catalogue'],
  ])('keeps %s (%s)', (title) => unchanged(title));

  it.each([
    'Live and Let Die',
    'Live Forever',
    'Video Killed the Radio Star',
    'Radio Ga Ga',
    'Original Sin',
    'Turn Your Radio On',
    'A Feat of Strength',
    'Welcome to Ft. Lauderdale',
    '6 Ft. Under',
    'Song feat. Kid Ink', // a bare "feat." could be a word of the title; only brackets and dash tails are read
  ])('keeps a title that only has a tag word in it: %s', (title) => expect(hasVersionTag(title)).toBe(false));

  it.each([
    'Live It Up', 'Live in Love', 'Live in the Moment', 'Live a Little', 'Live Together', 'Live for Tonight', 'Live On', 'Live Without You', 'Live Is Life', 'Long Live',
    'How Do I Live', 'We Live in a Material World', 'Saturday Night Live', 'Remix Me Baby', 'Concert Hall', 'Unplugged Love', 'Bootleg Blues',
    'The Theme', 'Love Theme', 'Happy Ending', 'Never Ending', 'Album Intro', 'The Intro', 'Single Ladies', 'Under Cover', 'Cover Me',
  ])('keeps a bracket that only starts or ends like a tag: Song (%s)', (inner) => unchanged(`Song (${inner})`));

  it('keeps a bracket that names a part, a reprise or an interlude, even next to a tag word', () => {
    for (const title of [
      'Another Brick in the Wall (Part 2 - Live)', 'Another Brick in the Wall (Pt. 2 Remastered)', 'Super Freak (Part 1 Edit)',
      'Sgt. Pepper (Reprise Remastered)', 'Tomorrow (Reprise)', 'Pass the Courvoisier (Part 2)', 'All of the Lights (Interlude)',
      'Another Brick in the Wall - Part 2 Remastered', 'Song (Intro)', 'Song - Never Fade Away',
    ]) unchanged(title);
  });

  it('keeps a language version, in any spelling: the lyrics differ, so it is not the song a visitor wants to sing', () => {
    for (const inner of [
      'English Version', 'Spanish Version', 'German', 'Japanese ver.', 'Eng. Ver.', 'Kor Ver.', 'Original Spanish Version', 'Spanish Radio Edit',
      'German Edit', 'Deutsche Version', 'Español Version', 'Français Version', 'Tamil Version', 'Spanish Version, Live', '1973 Swedish Version',
    ]) unchanged(`Song (${inner})`);
    unchanged('Song - Remastered German Version');
  });

  it('keeps instrumental, karaoke and dub tags, so the list still hides those songs on the tag', () => {
    for (const title of ['Song (Instrumental)', 'Song [Karaoke Version]', 'Back To Life - Satta Dub', 'Song (Backing Track)']) {
      expect(clean(title)).toBe(title);
      expect(hasLittleSinging(clean(title))).toBe(true);
    }
  });

  it('keeps a bracket the rules do not know, so a missed tag shows rather than a wrong song', () => {
    unchanged('Song (Hardstyle)');
    unchanged('Song (Keep It Real)');
    unchanged('Song (Baywatch Theme)'); // one word before "theme" could be a subtitle
  });

  it('does not tear a bracket apart at a dash inside it', () => {
    unchanged('Song (Pt. 2 - feat. Drake)');
    unchanged('Song (Subtitle - From "Frozen")');
    unchanged('Song [Part 2 - feat. Drake]');
    unchanged('Song (Na Na Na - ESC 2015 Romania)');
    expect(clean('Song (Na Na Na) - Live')).toBe('Song (Na Na Na)');
  });
});

describe('classifyTag', () => {
  it('reads the whole text, not a word inside it', () => {
    expect(classifyTag('A Deal With God')).toBeNull();
    expect(classifyTag('Turn Your Radio On')).toBeNull();
    expect(classifyTag('Live It Up')).toBeNull();
    expect(classifyTag('Album Version')).toEqual({ kind: 'version' });
    expect(classifyTag('LIVE AT WEMBLEY')).toEqual({ kind: 'live' });
    expect(classifyTag('Gilmore Girls Intro')).toEqual({ kind: 'context' });
  });
});

describe('foldKey: when two listings are one song', () => {
  const same = (a: [string, string], b: [string, string]) => foldKey(...a) === foldKey(...b);

  it('sets quote marks, hyphens, case, accents, "&", "the" and punctuation aside', () => {
    expect(same(['Aaliyah', "I Don't Wanna"], ['Aaliyah', 'I Don’t Wanna'])).toBe(true);
    expect(same(['E-40', 'U and Dat'], ['E‐40', 'U and Dat'])).toBe(true); // a Unicode hyphen
    expect(same(['Simon & Garfunkel', 'The Boxer'], ['Simon and Garfunkel', 'The Boxer'])).toBe(true);
    expect(same(['The Eagles', 'Hotel California'], ['Eagles', 'Hotel California'])).toBe(true);
    expect(same(['Céline Dion', 'Pour que tu m’aimes encore'], ['Celine Dion', "Pour que tu m'aimes encore"])).toBe(true);
    expect(same(['ABBA', 'Money Money Money'], ['ABBA', 'Money, Money, Money'])).toBe(true);
    expect(same(['A*Teens', 'Mamma Mia'], ['A★Teens', 'Mamma Mia'])).toBe(true);
    expect(same(['Gigi D’Agostino', 'L’amour toujours'], ["Gigi D'agostino", "L'amour Toujours"])).toBe(true);
  });

  it('reads the lead artist: a featured artist or a further credit does not make another song', () => {
    expect(same(['Mark Ronson ft Miley Cyrus', 'Nothing Breaks'], ['Mark Ronson feat. Miley Cyrus', 'Nothing Breaks'])).toBe(true);
    expect(same(['David Guetta feat. Nicki Minaj & Flo Rida', 'Where Them Girls At'], ['David Guetta feat. Flo Rida & Nicki Minaj', 'Where Them Girls At?'])).toBe(true);
    expect(same(['Jennifer Lopez & Pitbull', 'On The Floor'], ['Jennifer Lopez feat. Pitbull', 'On The Floor'])).toBe(true);
    expect(same(['Queen + David Bowie', 'Under Pressure'], ['Queen & David Bowie', 'Under Pressure'])).toBe(true);
    expect(same(['The Black Eyed Peas, Shakira', 'Girl Like Me'], ['Black Eyed Peas, Shakira', 'Girl Like Me'])).toBe(true);
    // the same song with and without its featured artist, as the release eval harness counts duplicates
    expect(same(['Calvin Harris', 'One Kiss'], ['Calvin Harris & Dua Lipa', 'One Kiss'])).toBe(true);
    expect(same(['Post Malone', 'Sunflower'], ['Post Malone & Swae Lee', 'Sunflower'])).toBe(true);
    expect(same(['Alan Jackson', "It's Five O'Clock Somewhere"], ['Alan Jackson feat. Jimmy Buffett', "It's Five O'Clock Somewhere"])).toBe(true);
    expect(same(['Disclosure feat. Sam Smith', 'Latch'], ['Disclosure feat. Jess Glynne', 'Latch'])).toBe(true);
  });

  it('keeps different songs apart', () => {
    expect(same(['Master P', "Make 'Em Say Uhh!"], ['Master P', "Make 'Em Say Uhh #2"])).toBe(false);
    expect(same(['Usher', 'Confessions Part I'], ['Usher', 'Confessions Part II'])).toBe(false);
    expect(same(['Jeff Buckley', 'Hallelujah'], ['Leonard Cohen', 'Hallelujah'])).toBe(false);
    expect(same(['A feat. B', 'Song'], ['B feat. A', 'Song'])).toBe(false); // the lead artist counts
    expect(same(['Hall & Oates', 'Rich Girl'], ['Oates & Hall', 'Rich Girl'])).toBe(false);
    expect(same(['Kendrick Lamar', 'The Heart Part 4'], ['Kendrick Lamar', 'Heart Part 4'])).toBe(false); // "the" only counts for an artist
    expect(same(['A', 'Song 2'], ['A', 'Song #2.5'])).toBe(false);
  });

  it('keeps apart titles that differ only in a mark or symbol of a script that is not Latin, or in a fraction', () => {
    expect(same(['X', 'ばか'], ['X', 'はか'])).toBe(false);
    expect(same(['X', 'कल'], ['X', 'काल'])).toBe(false);
    expect(same(['X', 'น้ำ'], ['X', 'นำ'])).toBe(false);
    expect(same(['X', '½'], ['X', '12'])).toBe(false);
    expect(same(['X', 'Él'], ['X', 'El'])).toBe(true); // a Latin accent is set aside
  });

  it('never folds a song with nothing but symbols in its title or artist', () => {
    expect(foldKey('Artist', '???')).toBeNull();
    expect(foldKey('', 'Title')).toBeNull();
  });
});
