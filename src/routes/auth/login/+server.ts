import type { RequestHandler } from '@sveltejs/kit';
import { login } from '$lib/server/auth';
export const GET: RequestHandler = async event => {
  try { return await login(event); }
  catch { return new Response('Sign-in is temporarily unavailable.', { status: 503 }); }
};
