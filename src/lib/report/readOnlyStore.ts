// A store for reports run against the real database: reads go through, writes are dropped, so the
// database is left as it was found. Every Store method is listed below as a read or a write, so a
// method added to Store later cannot slip through unclassified (TypeScript asks for it here).

import type { Store } from '../server/store';

const ACCESS: Record<keyof Store, 'read' | 'write'> = {
  getUser: 'read',
  upsertUser: 'write',
  listUserIds: 'read',
  saveRange: 'write',
  getRange: 'read',
  getSongRange: 'read',
  getSongRanges: 'read',
  putSongRange: 'write',
  listMeasuredRangesByArtist: 'read',
  listSongRangesByArtist: 'read',
  putUsdbSongs: 'write',
  findUsdbSongs: 'read',
  listUsdbSongs: 'read',
  usdbIndexStats: 'read',
  appendLog: 'write',
  listLog: 'read',
  saveFeedback: 'write',
  listFeedback: 'read',
  listCatalogue: 'read',
  appendEvents: 'write',
  listEvents: 'read',
  putSongMoods: 'write',
  getSongMoods: 'read',
  putSongPopularity: 'write',
  getSongPopularity: 'read',
  putSongDeezer: 'write',
  listSongDeezer: 'read',
  getSpotifyBlock: 'read',
  setSpotifyBlock: 'write',
  getLibraryState: 'read',
  putLibraryState: 'write',
  listSavedTracks: 'read',
  putSavedTracks: 'write',
  removeSavedTracks: 'write',
  deleteUserLibrary: 'write',
  deleteIdleLibraries: 'write',
  addSpotifyCalls: 'write',
  listSpotifyCalls: 'read',
  putSongTempo: 'write',
  getSongTempos: 'read',
  listSongTempos: 'read',
};

export function readOnlyStore(store: Store): Store {
  const skip = async () => {};
  const methods = Object.keys(ACCESS) as (keyof Store)[];
  return Object.fromEntries(methods.map((k) => [k, ACCESS[k] === 'read' ? store[k].bind(store) : skip])) as unknown as Store;
}
