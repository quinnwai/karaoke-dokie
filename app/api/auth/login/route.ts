import { login } from '../../../../src/lib/server/handlers';
import { getAppContext } from '../../../../src/lib/server/wiring';

export async function GET(req: Request): Promise<Response> {
  return login(req, getAppContext());
}
