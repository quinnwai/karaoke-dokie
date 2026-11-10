import { KaraokeApp } from '../src/components/KaraokeApp';
import { pickSongsOn, postHogSettings } from '../src/lib/server/config';

// Read on every request, not at build time, so PICK_SONGS decides without a rebuild (and the e2e's two servers,
// one build, can differ). The PostHog key, host and environment are read the same way.
export const dynamic = 'force-dynamic';

export default function Home() {
  return <KaraokeApp pickSongs={pickSongsOn(process.env)} postHog={postHogSettings(process.env)} />;
}
