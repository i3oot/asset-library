import type { RequestHandler } from '@sveltejs/kit';
export const GET: RequestHandler = event => Response.json({ authenticated: Boolean(event.locals.nativeAuth && event.locals.user), ...(event.locals.nativeAuth && event.locals.user ? { user: { subject: event.locals.user.subject, issuer: event.locals.user.issuer } } : {}) });
