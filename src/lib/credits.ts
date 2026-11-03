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
    name: 'MGPHot, SiriusXM',
    url: 'https://doi.org/10.5334/tismir.236',
    what: "Music experts' notes on Billboard Hot 100 songs from 1958 to 2022, by Oramas, Gouyon, Hogan, Landau and Ehmann (2025). We used it offline only, to check our mood labels; none of it is shown in the app (CC BY-NC-ND 4.0, © SiriusXM 2025).",
  },
  {
    name: 'AcousticBrainz, MetaBrainz',
    url: 'https://acousticbrainz.org/',
    what: 'Computer analysis of how recordings sound (happy, sad, relaxed, danceable), which we turn into the Upbeat and Heartfelt labels (CC0).',
  },
  {
    name: 'OpenAI GPT-6 Luna',
    url: 'https://openai.com/',
    what: "An AI model that suggests Upbeat and Heartfelt labels from a song's artist, title and year, ahead of time, for songs the analysis above does not cover. We show a mood only once its labels pass our accuracy check.",
  },
  {
    name: 'Material Symbols, Google',
    url: 'https://fonts.google.com/icons',
    what: 'The fast-lyrics icon (Apache 2.0).',
  },
  {
    name: 'Spotify',
    url: 'https://developer.spotify.com/',
    what: 'Your saved songs, top tracks and recent plays.',
  },
];
