import { KaraokeApp } from '../src/components/KaraokeApp';
import { pickSongsOn } from '../src/lib/server/config';

// Read on every request, not at build time, so PICK_SONGS decides without a rebuild (and the e2e's two servers,
// one build, can differ).
export const dynamic = 'force-dynamic';

export default function Home() {
  return <KaraokeApp pickSongs={pickSongsOn(process.env)} />;
}
