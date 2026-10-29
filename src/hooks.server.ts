import { authEnabled, authHealth, sessionUser } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit/hooks';

export const handle: Handle = async ({ event, resolve }) => {
  const origin = event.request.headers.get('origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) && origin && origin !== event.url.origin) {
    return Response.json({ error: 'Cross-origin mutations are forbidden' }, { status: 403 });
  }
  if (event.url.pathname === '/healthz' && event.request.method === 'GET') {
    try { await authHealth(); return Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' } }); }
    catch { return Response.json({ ready: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  }
  try {
    event.locals.nativeAuth = authEnabled();
    event.locals.user = await sessionUser(event);
  } catch { return Response.json({ error: 'Authentication unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  const authRoutes = ['/auth/login', '/auth/callback', '/auth/logout', '/auth/check', '/auth/error', '/auth/signed-out'];
  const staticResource = event.url.pathname.startsWith('/_app/') || event.url.pathname.startsWith('/fonts/') || event.url.pathname === '/favicon.ico';
  if (event.locals.nativeAuth && !event.locals.user && !authRoutes.includes(event.url.pathname) && !staticResource) {
    if (event.url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(event.request.method)) return Response.json({ error: 'Authentication required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    return new Response(null, { status: 302, headers: { Location: '/auth/login?returnTo=' + encodeURIComponent(event.url.pathname + event.url.search), 'Cache-Control': 'no-store' } });
  }
  const response = await resolve(event);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // Suppress cross-origin referrers while keeping same-origin POST form Origin headers.
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), tools=(self)');
  if (event.locals.nativeAuth || event.url.pathname.startsWith('/auth/')) response.headers.set('Cache-Control', 'private, no-store');
  if (event.url.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'private, no-store');
    if (/^\/api\/assets\/[^/]+\/(?:versions\/[^/]+\/)?(file|download|thumbnail)$/.test(event.url.pathname)) {
      response.headers.set('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    }
  }
  return response;
};
