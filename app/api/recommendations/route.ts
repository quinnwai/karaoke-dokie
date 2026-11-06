import { recommendations } from '../../../src/lib/server/handlers';
import { getAppContext } from '../../../src/lib/server/wiring';

// A first load of a big library reads hundreds of Spotify pages (QWW-31: 11,000 liked songs is about 30 s).
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  return recommendations(req, getAppContext());
}
