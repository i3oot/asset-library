import type { RequestHandler } from '@sveltejs/kit';
import { callback } from '$lib/server/auth';
export const GET: RequestHandler = async event => {
  try { return await callback(event); }
  catch { return new Response(null, { status: 303, headers: { Location: '/auth/error' } }); }
};
