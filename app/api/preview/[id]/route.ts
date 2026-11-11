import { createPreviewResolver, previewResponse } from '../../../../src/lib/server/preview';

// One per server instance, so every request it serves shares the cached links.
const resolver = createPreviewResolver();

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return previewResponse(id, resolver);
}
