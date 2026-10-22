import { putRange } from '../../../../src/lib/server/handlers';
import { getAppContext } from '../../../../src/lib/server/wiring';

export async function PUT(req: Request): Promise<Response> {
  return putRange(req, getAppContext());
}
