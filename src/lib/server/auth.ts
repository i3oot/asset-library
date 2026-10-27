import { createHash, randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import type { RequestEvent } from '@sveltejs/kit';
import { createDatabase, type Database } from './database';

export interface AuthUser { subject: string; issuer: string; name: string; email?: string; groups: string[] }
let database: Promise<Database> | undefined;
let configuration: Promise<oidc.Configuration> | undefined;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const local = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);

export function authEnabled(): boolean {
  const mode = process.env.AUTH_MODE ?? 'none';
  if (!['none', 'oidc'].includes(mode)) throw new Error('Invalid authentication mode');
  return mode === 'oidc';
}
function settings() {
  if (!authEnabled()) throw new Error('Native login is disabled');
  if (!process.env.ORIGIN || !process.env.OIDC_ISSUER_URL || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) throw new Error('Incomplete OIDC configuration');
  const origin = new URL(process.env.ORIGIN);
  const issuer = new URL(process.env.OIDC_ISSUER_URL);
  const insecureLocal = process.env.OIDC_ALLOW_HTTP_LOCALHOST === 'true' && local(origin) && local(issuer);
  for (const url of [origin, issuer]) {
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(insecureLocal && url.protocol === 'http:'))) throw new Error('OIDC requires trusted HTTPS URLs');
  }
  const ttl = Number(process.env.OIDC_SESSION_MAX_AGE_SECONDS ?? 3600);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 28800) throw new Error('Invalid OIDC session lifetime');
  return { origin: origin.origin, issuer, clientId: process.env.OIDC_CLIENT_ID, secret: process.env.OIDC_CLIENT_SECRET,
    secure: origin.protocol === 'https:', insecureLocal, ttl,
    groups: (process.env.OIDC_ALLOWED_GROUPS ?? '').split(',').map(value => value.trim()).filter(Boolean) };
}
async function db() {
  database ??= createDatabase().catch(error => { database = undefined; throw error; });
  return database;
}
export async function authHealth() {
  if (authEnabled()) settings();
  await (await db()).prepare('SELECT 1').get();
}
async function config() {
  if (!configuration) {
    configuration = (async () => {
      const s = settings();
      const options: oidc.DiscoveryRequestOptions = { timeout: 10, execute: [oidc.enableNonRepudiationChecks] };
      if (s.insecureLocal) options.execute!.push(oidc.allowInsecureRequests);
      if (process.env.OIDC_INTERNAL_ORIGIN) {
        const internal = new URL(process.env.OIDC_INTERNAL_ORIGIN);
        if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) throw new Error('Invalid internal IdP origin');
        options[oidc.customFetch] = async (input, init) => {
          const target = new URL(input);
          if (target.origin !== s.issuer.origin || !target.pathname.startsWith('/application/o/')) throw new Error('Untrusted IdP endpoint');
          const headers = new Headers(init.headers);
          headers.set('Host', target.host); headers.set('X-Forwarded-Proto', 'https');
          const body = init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body;
          return fetch(new URL(target.pathname + target.search, internal), { ...init, body, headers, redirect: 'manual' });
        };
      }
      return oidc.discovery(s.issuer, s.clientId, s.secret, oidc.ClientSecretBasic(s.secret), options);
    })().catch(error => { configuration = undefined; throw error; });
  }
  return configuration;
}
function cookieSettings() {
  const s = settings();
  return { path: '/', httpOnly: true, secure: s.secure, sameSite: 'lax' as const };
}
function cookieName(kind: 'session' | 'transaction') { return `${settings().secure ? '__Host-' : ''}asset-library-${kind}`; }
function returnPath(value: string | null) {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  const s = settings();
  try { const url = new URL(value, s.origin); return url.origin === s.origin && !url.pathname.startsWith('//') && !url.pathname.startsWith('/auth/') ? url.pathname + url.search : '/'; }
  catch { return '/'; }
}
export async function sessionUser(event: RequestEvent): Promise<AuthUser | null> {
  if (!authEnabled()) return null;
  const id = event.cookies.get(cookieName('session'));
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const row = await (await db()).prepare('SELECT user_json, expires_at FROM auth_sessions WHERE id_hash = ?').get(hash(id)) as { user_json: string; expires_at: number | string } | undefined;
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  const user = JSON.parse(row.user_json) as AuthUser;
  const s = settings();
  if (user.issuer !== s.issuer.href || !user.subject || !Array.isArray(user.groups) || (s.groups.length && !s.groups.some(group => user.groups.includes(group)))) return null;
  return user;
}
export async function login(event: RequestEvent) {
  const s = settings(); const client = await config(); const connection = await db();
  const id = random(), state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
  await connection.prepare('DELETE FROM oidc_transactions WHERE expires_at <= ?').run(Date.now());
  await connection.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
  await connection.prepare('INSERT INTO oidc_transactions (id_hash, state, verifier, nonce, return_path, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hash(id), state, verifier, nonce, returnPath(event.url.searchParams.get('returnTo')), Date.now() + 600_000);
  const url = oidc.buildAuthorizationUrl(client, { redirect_uri: s.origin + '/auth/callback', scope: 'openid profile email', state, nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
  event.cookies.set(cookieName('transaction'), id, { ...cookieSettings(), maxAge: 600 });
  return new Response(null, { status: 302, headers: { Location: url.href } });
}
export async function callback(event: RequestEvent) {
  const s = settings(), connection = await db();
  const id = event.cookies.get(cookieName('transaction'));
  event.cookies.delete(cookieName('transaction'), cookieSettings());
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('Missing login transaction');
  // DELETE RETURNING consumes the transaction atomically on both supported backends.
  const transaction = await connection.prepare('DELETE FROM oidc_transactions WHERE id_hash = ? RETURNING *').get(hash(id)) as
    { state: string; verifier: string; nonce: string; return_path: string; expires_at: number | string } | undefined;
  if (!transaction || Number(transaction.expires_at) <= Date.now()) throw new Error('Expired login transaction');
  const tokens = await oidc.authorizationCodeGrant(await config(), new URL(s.origin + event.url.pathname + event.url.search), {
    expectedState: transaction.state, expectedNonce: transaction.nonce, pkceCodeVerifier: transaction.verifier, idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512 || typeof claims.exp !== 'number') throw new Error('Invalid identity');
  const groups = Array.isArray(claims.groups) ? claims.groups.filter((value): value is string => typeof value === 'string' && value.length <= 256).slice(0, 128) : [];
  if (s.groups.length && !s.groups.some(group => groups.includes(group))) throw new Error('Identity not authorized');
  const user: AuthUser = { subject: claims.sub, issuer: s.issuer.href,
    name: String(claims.name ?? claims.preferred_username ?? claims.sub).slice(0, 256),
    ...(typeof claims.email === 'string' ? { email: claims.email.slice(0, 256) } : {}), groups };
  const expires = Math.min(Date.now() + s.ttl * 1000, claims.exp * 1000);
  if (expires <= Date.now()) throw new Error('Expired identity');
  const old = event.cookies.get(cookieName('session'));
  if (old) await connection.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').run(hash(old));
  const session = random();
  await connection.prepare('INSERT INTO auth_sessions (id_hash, user_json, expires_at) VALUES (?, ?, ?)').run(hash(session), JSON.stringify(user), expires);
  event.cookies.set(cookieName('session'), session, { ...cookieSettings(), maxAge: Math.floor((expires - Date.now()) / 1000) });
  // Access, refresh and ID tokens are discarded; only the minimal identity and opaque session remain.
  return new Response(null, { status: 303, headers: { Location: returnPath(transaction.return_path) } });
}
export async function logout(event: RequestEvent) {
  const s = settings();
  if (event.request.headers.get('origin') !== s.origin) return Response.json({ error: 'Invalid logout origin' }, { status: 403 });
  const id = event.cookies.get(cookieName('session'));
  if (id) await (await db()).prepare('DELETE FROM auth_sessions WHERE id_hash = ?').run(hash(id));
  event.cookies.delete(cookieName('session'), cookieSettings());
  return new Response(null, { status: 303, headers: { Location: '/auth/signed-out' } });
}
