// Who the app's data and know-how come from. Shown on /credits and kept in step with the README.

export interface Credit {
  name: string;
  url: string;
  what: string;
}

export const CREDITS: Credit[] = [
  {
    name: 'USDB (UltraStar DataBase)',
    url: 'https://usdb.animux.de/',
    what: 'The fan-made UltraStar note files we compute song ranges from. Each song links to its USDB page where we know it. We keep only the numbers, never the files or lyrics.',
  },
  {
    name: 'USDB Syncer by Markus Böhning',
    url: 'https://github.com/bohning/usdb_syncer',
    what: 'Our reference for how to talk to USDB and keep a copy of its song list up to date (GPLv3; ideas only, no code copied).',
  },
  {
    name: 'singmania',
    url: 'https://github.com/andrrms/singmania',
    what: 'A public collection of UltraStar note files (originally from USDB). We computed song ranges from it.',
  },
  {
    name: 'AllKaraoke',
    url: 'https://github.com/Asvarox/allkaraoke',
    what: 'A public collection of UltraStar note files (originally from USDB). We computed song ranges from it.',
  },
  {
    name: 'UltraStar format and community',
    url: 'https://usdx.eu/format/',
    what: 'The open karaoke note-file format, and the people who transcribe songs in it.',
  },
  {
    name: 'NSynth dataset, Google Magenta',
    url: 'https://magenta.tensorflow.org/datasets/nsynth',
    what: 'Labeled sung notes used to test note detection (CC BY 4.0).',
  },
  {
    name: 'Material Symbols, Google',
    url: 'https://fonts.google.com/icons',
    what: 'The fast-lyrics and octave icons (Apache 2.0).',
  },
  {
    name: 'Spotify',
    url: 'https://developer.spotify.com/',
    what: 'Your saved songs, top tracks and recent plays.',
  },
];
