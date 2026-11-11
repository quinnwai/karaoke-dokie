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
  // AcousticBrainz (CC0) joins this list once its mood labels are imported; its API was down when
  // the first labels were made, so none of what the app shows comes from it yet (QWW-17).
  {
    name: 'OpenAI GPT-6 Luna',
    url: 'https://openai.com/',
    what: "An AI model that suggests Upbeat and Heartfelt labels from a song's artist, title and year, ahead of time. We show a mood only once its labels pass our accuracy check.",
  },
  {
    name: 'Material Symbols, Google',
    url: 'https://fonts.google.com/icons',
    what: 'The fast-lyrics, book and reset icons (Apache 2.0).',
  },
  {
    name: 'KaraFun',
    url: 'https://www.karafun.com/',
    what: 'How often KaraFun’s karaoke video of a song has been watched on YouTube, one of the signs of how well known a song is.',
  },
  {
    name: 'Billboard Year-End Hot 100',
    url: 'https://www.billboard.com/charts/year-end/hot-100-songs/',
    what: 'Each song’s best year-end chart position, which marks it as widely known, and its year when we have no other.',
  },
  {
    name: 'Spotify',
    url: 'https://developer.spotify.com/',
    what: 'Your saved songs, top tracks and recent plays, and the song player (it loads from Spotify, which sets its own cookies).',
  },
  {
    name: 'Deezer',
    url: 'https://www.deezer.com/',
    what: 'The 30-second previews behind the play button on each song, streamed from Deezer for your own private, non-commercial listening. We never keep the audio. Deezer’s track ranks are also one of the signs of how well known a song is.',
  },
];
