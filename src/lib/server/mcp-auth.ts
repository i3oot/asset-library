import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { AuthUser } from './auth';

export type McpIdentity = { user: AuthUser; scopes: string[]; expiresAt: number };
const local = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
export function mcpSettings() {
  if (process.env.MCP_ENABLED !== 'true' || process.env.AUTH_MODE !== 'oidc') throw new Error('MCP is disabled');
  const resource = new URL(process.env.MCP_RESOURCE_URL ?? '');
  const issuer = new URL(process.env.MCP_OIDC_ISSUER_URL ?? '');
  for (const url of [resource, issuer]) {
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(process.env.OIDC_ALLOW_HTTP_LOCALHOST === 'true' && local(url) && url.protocol === 'http:'))) throw new Error('MCP requires trusted HTTPS URLs');
  }
  if (resource.pathname !== '/mcp' || !issuer.pathname.endsWith('/')) throw new Error('Invalid MCP resource or issuer');
  return { resource, issuer, metadata: resource.origin + '/.well-known/oauth-protected-resource/mcp' };
}

// Only configured IdP endpoints may use the private cluster transport. Never
// follow a redirect, token-supplied URL or token-supplied signing key location.
async function issuerFetch(url: URL) {
  const { issuer } = mcpSettings();
  if (url.origin !== issuer.origin || !url.pathname.startsWith(issuer.pathname)) throw new Error('Untrusted MCP IdP endpoint');
  const headers = new Headers({ Accept: 'application/json' });
  let target = url;
  if (process.env.OIDC_INTERNAL_ORIGIN) {
    const internal = new URL(process.env.OIDC_INTERNAL_ORIGIN);
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) throw new Error('Invalid internal IdP origin');
    headers.set('Host', url.host); headers.set('X-Forwarded-Host', url.host); headers.set('X-Forwarded-Proto', 'https');
    target = new URL(url.pathname + url.search, internal);
  }
  return fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
}
let keys: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
async function signingKeys() {
  keys ??= (async () => {
    const { issuer } = mcpSettings();
    const response = await issuerFetch(new URL('.well-known/openid-configuration', issuer));
    if (!response.ok) throw new Error('MCP discovery unavailable');
    const metadata = await response.json();
    if (metadata.issuer !== issuer.href || typeof metadata.jwks_uri !== 'string') throw new Error('MCP issuer mismatch');
    const jwks = new URL(metadata.jwks_uri);
    if (jwks.origin !== issuer.origin || !jwks.pathname.startsWith(issuer.pathname) || jwks.search || jwks.hash) throw new Error('Untrusted JWKS');
    return createRemoteJWKSet(jwks, { [customFetch]: async input => issuerFetch(new URL(String(input))), timeoutDuration: 5000 });
  })().catch(error => { keys = undefined; throw error; });
  return keys;
}

export async function mcpIdentity(request: Request): Promise<McpIdentity | null> {
  const header = request.headers.get('authorization');
  if (!header || header.length > 16384 || !/^Bearer [A-Za-z0-9._~-]+$/i.test(header)) return null;
  try {
    const { resource, issuer } = mcpSettings();
    const { payload } = await jwtVerify(header.slice(7), await signingKeys(), {
      issuer: issuer.href, audience: resource.href, algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'azp', 'uid', 'scope'], maxTokenAge: '15m', clockTolerance: 5,
    });
    // Authentik access tokens carry azp, uid and scope; ID tokens do not.
    if (payload.azp !== resource.href || typeof payload.uid !== 'string' || !payload.uid ||
      typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512 ||
      typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.exp - payload.iat > 900 ||
      typeof payload.scope !== 'string') return null;
    const scopes = payload.scope.split(' ').filter(Boolean);
    if (!scopes.includes('assets:read')) return null;
    return { scopes, expiresAt: payload.exp, user: { subject: payload.sub, issuer: issuer.href,
      name: String(payload.name ?? payload.preferred_username ?? payload.sub).slice(0, 256),
      groups: Array.isArray(payload.groups) ? payload.groups.filter((v): v is string => typeof v === 'string' && v.length <= 256).slice(0, 128) : [] } };
  } catch { return null; }
}

export function mcpChallenge() {
  const { metadata } = mcpSettings();
  return new Response(JSON.stringify({ error: 'Bearer access token required' }), { status: 401, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'WWW-Authenticate': `Bearer resource_metadata="${metadata}", scope="assets:read"`,
  } });
}
