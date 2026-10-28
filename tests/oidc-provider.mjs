import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'oidc-test', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(claims, badSignature) {
  const input = encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }) + '.' + encode(claims);
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), badSignature ? other.privateKey : pair.privateKey).toString('base64url');
}
export async function provider(t, options = {}) {
  let issuer, internalOrigin; const codes = new Map(); let mode = 'valid'; let exchanges = 0;
  const prefix = options.privateTransport ? '/application/o/fixture/' : '/';
  const forwardedPaths = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, issuer);
    if (options.privateTransport) {
      if (request.headers['x-forwarded-host'] !== new URL(issuer).host || request.headers['x-forwarded-proto'] !== 'https') {
        response.writeHead(400); response.end(); return;
      }
      forwardedPaths.push(url.pathname);
      url.pathname = '/' + url.pathname.slice(prefix.length);
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ issuer,
        authorization_endpoint: issuer + 'authorize', token_endpoint: issuer + 'token', jwks_uri: issuer + 'jwks',
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'] }));
    } else if (url.pathname === '/authorize') {
      const code = 'test-code-' + codes.size;
      codes.set(code, Object.fromEntries(url.searchParams));
      const target = new URL(url.searchParams.get('redirect_uri')); target.searchParams.set('code', code); target.searchParams.set('state', url.searchParams.get('state'));
      response.writeHead(302, { Location: target.href }); response.end();
    } else if (url.pathname === '/jwks') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ keys: [jwk] }));
    } else if (url.pathname === '/token') {
      exchanges++; let raw = ''; for await (const chunk of request) raw += chunk;
      const params = new URLSearchParams(raw); const transaction = codes.get(params.get('code')); codes.delete(params.get('code'));
      const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
      const basic = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /i, ''), 'base64').toString().split(':').map(value => decodeURIComponent(value.replace(/\+/g, ' ')));
      if (!transaction || transaction.code_challenge !== challenge || basic[0] !== 'test-client' || basic[1] !== 'TEST_ONLY_OIDC_SECRET' || transaction.redirect_uri !== params.get('redirect_uri')) {
        response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'invalid_grant' })); return;
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: mode === 'issuer' ? issuer + 'wrong' : issuer, sub: 'test-user', aud: mode === 'audience' ? 'wrong-client' : 'test-client', iat: now,
        exp: mode === 'expired' ? now - 120 : now + 900, nonce: mode === 'nonce' ? 'wrong-nonce' : transaction.nonce,
        name: 'Test User', email: 'test@example.invalid', groups: ['library-users'] };
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ access_token: 'TEST_ONLY_ACCESS_TOKEN', token_type: 'Bearer', expires_in: 900, id_token: jwt(claims, mode === 'signature') }));
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); internalOrigin = `http://127.0.0.1:${server.address().port}`;
  issuer = options.privateTransport ? 'https://auth.example.invalid' + prefix : internalOrigin + '/';
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { issuer, internalOrigin, forwardedPaths, mode(value) { mode = value; }, exchanges: () => exchanges };
}
