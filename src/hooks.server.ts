import type { Handle } from '@sveltejs/kit/hooks';

export const handle: Handle = async ({ event, resolve }) => {
  const origin = event.request.headers.get('origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) && origin && origin !== event.url.origin) {
    return Response.json({ error: 'Cross-origin mutations are forbidden' }, { status: 403 });
  }
  const response = await resolve(event);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (event.url.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'private, no-store');
    if (/^\/api\/assets\/[^/]+\/(file|download)$/.test(event.url.pathname)) {
      response.headers.set('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    }
  }
  return response;
};
