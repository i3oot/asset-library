import type { RequestHandler } from '@sveltejs/kit';
import { logout } from '$lib/server/auth';
export const POST: RequestHandler = async event => {
  try { return await logout(event); }
  catch { return new Response('Sign-out is temporarily unavailable.', { status: 503 }); }
};
