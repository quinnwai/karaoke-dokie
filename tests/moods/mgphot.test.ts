import { describe, expect, it } from 'vitest';
import { leadArtist, MGPHOT_PROXIES, mgphotGold, mgphotMoods, mgphotRecords, readMgphot, type MgphotGenes } from '../../src/lib/moods/mgphot';

// Made-up songs in MGPHot's file layout; no rows from the real dataset (CC BY-NC-ND, never
// committed). Gene ids are out of MGPHot's order, so the reader must go by name.
const GENES_TSV = [
  'gene_id\tname\tcategory\tdescription',
  '0\tVocal Grit\tvocals\tnot read',
  '1\tSad Lyrics\tlyrics\tx',
  '2\tDanceability\trhythm\tx',
  '3\tLove/Romance Lyrics\tlyrics\tx',
  '4\tAural Intensity\tsonority\tx',
].join('\n');

/** gene_values in the fixture's id order: grit, sad, dance, love, intensity. */
const row = (artist: string, title: string, [sad, dance, love, intensity]: number[]) =>
  `2001\t1\t${artist}\t${title}\t${JSON.stringify([0.5, sad, dance, love, intensity])}`;

const VALUES_TSV = [
  'year\tmgphot_track_id\tartist\ttitle\tgene_values',
  row('Test Band', 'Jump Around Town', [0.2, 0.8, 0.1, 0.1]), // danceable, not sad: upbeat
  row('Test Band', 'Quiet Tears', [0.6, 0.2, 0, 0.3]), // sad: heartfelt
  row('Ana Example and Ben Sample', 'Two Hearts', [0.59, 0.79, 0.6, 0.7]), // loud, love: both
  row('Cara Demo, Dan Mock', 'Plain Song', [0.59, 0.79, 0.59, 0.69]), // just under every bar: neither
  row('Test Band', 'Jump Around Town (Remix)', [0.9, 0.1, 0.9, 0.1]), // same key as the first row, which wins
  row('Test Band with Someone', 'Quiet Tears', [0, 0, 0.9, 0]), // its lead key is taken by a credit that matches exactly
  row('Ed Fake', 'Loud Sad Song', [0.6, 0.5, 0, 0.9]), // loud but sad: heartfelt only
].join('\r\n');

describe('readMgphot', () => {
  const { songs, byKey, viaLead } = readMgphot(GENES_TSV, VALUES_TSV);
  const moods = Object.fromEntries([...byKey].map(([k, g]) => [k, mgphotMoods(g)]));

  it('keys every song by artist and title, and duets by their first artist too; the first row wins a key', () => {
    expect(songs).toBe(7);
    expect(moods).toEqual({
      'test band|jump around town': ['upbeat'],
      'test band|quiet tears': ['heartfelt'],
      'ana example and ben sample|two hearts': ['upbeat', 'heartfelt'],
      'cara demo, dan mock|plain song': [],
      'test band with someone|quiet tears': ['heartfelt'],
      'ed fake|loud sad song': ['heartfelt'],
      'ana example|two hearts': ['upbeat', 'heartfelt'],
      'cara demo|plain song': [],
    });
    expect(viaLead).toBe(2);
    expect(byKey.get('test band|jump around town')).toEqual({ Danceability: 0.8, 'Aural Intensity': 0.1, 'Sad Lyrics': 0.2, 'Love/Romance Lyrics': 0.1 });
  });

  it('refuses files without the attributes the rules read, naming what is missing', () => {
    expect(() => readMgphot(GENES_TSV.replace('Sad Lyrics', 'Sad Lyric'), VALUES_TSV)).toThrow('mgphot_genes.tsv has no "Sad Lyrics"');
    expect(() => readMgphot(GENES_TSV, VALUES_TSV.replace('gene_values', 'values'))).toThrow('no gene_values column');
    const short = `${VALUES_TSV}\n2001\t9\tShort Row\tSong\t[0.1, 0.2]`;
    expect(() => readMgphot(GENES_TSV, short)).toThrow('line 9: missing Danceability');
  });
});

describe('MGPHOT_PROXIES', () => {
  const g = (over: Partial<MgphotGenes>): MgphotGenes => ({ Danceability: 0, 'Aural Intensity': 0, 'Sad Lyrics': 0, 'Love/Romance Lyrics': 0, ...over });

  it('Upbeat: danceable or loud, and not sad; the bars count as reached', () => {
    expect(MGPHOT_PROXIES.upbeat.test(g({ Danceability: 0.8 }))).toBe(true);
    expect(MGPHOT_PROXIES.upbeat.test(g({ 'Aural Intensity': 0.7 }))).toBe(true);
    expect(MGPHOT_PROXIES.upbeat.test(g({ Danceability: 0.79, 'Aural Intensity': 0.69 }))).toBe(false);
    expect(MGPHOT_PROXIES.upbeat.test(g({ Danceability: 1, 'Sad Lyrics': 0.6 }))).toBe(false);
  });

  it('Heartfelt: strong love or sad lyrics', () => {
    expect(MGPHOT_PROXIES.heartfelt.test(g({ 'Love/Romance Lyrics': 0.6 }))).toBe(true);
    expect(MGPHOT_PROXIES.heartfelt.test(g({ 'Sad Lyrics': 0.6 }))).toBe(true);
    expect(MGPHOT_PROXIES.heartfelt.test(g({ 'Love/Romance Lyrics': 0.59, 'Sad Lyrics': 0.59 }))).toBe(false);
  });

  it('splits a credit at its first "and", "&", "with" or comma', () => {
    expect(['A and B', 'A & B', 'A with B', 'A, B and C', 'A'].map(leadArtist)).toEqual(['A', 'A', 'A', 'A', 'A']);
    expect(leadArtist('Sandy Andrews')).toBe('Sandy Andrews');
  });
});

describe('mgphotRecords and mgphotGold', () => {
  const { byKey } = readMgphot(GENES_TSV, VALUES_TSV);

  it('gives every key a store row with the method and source, moods possibly none', () => {
    const rows = mgphotRecords(byKey);
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.key === 'cara demo|plain song')).toEqual({ key: 'cara demo|plain song', moods: [], method: 'mgphot-proxy-v1', source: 'mgphot' });
    expect(rows.find((r) => r.key === 'ana example|two hearts')?.moods).toEqual(['upbeat', 'heartfelt']);
  });

  it('builds a stand-in gold set from the listed keys MGPHot has, each once', () => {
    const gold = mgphotGold(['ed fake|loud sad song', 'nobody|unknown song', 'test band|jump around town', 'ed fake|loud sad song'], byKey);
    expect(gold.songs).toEqual([
      { key: 'ed fake|loud sad song', artist: '', title: '', upbeat: false, heartfelt: true },
      { key: 'test band|jump around town', artist: '', title: '', upbeat: true, heartfelt: false },
    ]);
    expect(gold.labelledBy).toContain('provisional');
  });
});
