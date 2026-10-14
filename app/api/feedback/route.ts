import { postFeedback } from '../../../src/lib/server/handlers';
import { getAppContext } from '../../../src/lib/server/wiring';

export async function POST(req: Request): Promise<Response> {
  return postFeedback(req, getAppContext());
}
