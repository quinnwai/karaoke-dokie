import { setlist } from '../../../src/lib/server/handlers';
import { getAppContext } from '../../../src/lib/server/wiring';

// A signed-in singer's first request reads their whole Spotify library, like /api/recommendations (QWW-31).
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  return setlist(req, getAppContext());
}
