import { json, type RequestHandler } from '@sveltejs/kit';
import { readAssetHistory } from '$lib/server/assets';
export const GET: RequestHandler = async ({ params, url }) => {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return json({ error: 'Invalid history page.' }, { status: 400 });
  const history = await readAssetHistory(params.id!, offset, limit);
  return history ? json(history) : json({ error: 'Asset not found.' }, { status: 404 });
};
