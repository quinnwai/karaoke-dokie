import { logout } from '../../../../src/lib/server/handlers';

export async function POST(req: Request): Promise<Response> {
  return logout(req);
}
