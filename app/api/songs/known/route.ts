import { knownSongs } from '../../../../src/lib/server/handlers';
import { getAppContext } from '../../../../src/lib/server/wiring';

export async function GET(req: Request): Promise<Response> {
  return knownSongs(req, getAppContext());
}
