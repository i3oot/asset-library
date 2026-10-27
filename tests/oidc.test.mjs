import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { provider } from './oidc-provider.mjs';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';
import { createDatabase } from '../src/lib/server/database.ts';


function cookies(response) { return response.headers.getSetCookie().filter(value => !value.includes('Max-Age=0')).map(value => value.split(';')[0]).join('; '); }
async function begin(app, returnTo = '/') {
  const login = await app.request('/auth/login?returnTo=' + encodeURIComponent(returnTo), { redirect: 'manual' }); assert.equal(login.status, 302);
  const transaction = cookies(login); const location = new URL(login.headers.get('location'));
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256'); assert.ok(location.searchParams.get('nonce')); assert.ok(location.searchParams.get('state'));
  const authorization = await fetch(location, { redirect: 'manual' }); assert.equal(authorization.status, 302);
  return { transaction, callback: new URL(authorization.headers.get('location')), login };
}
async function finish(app, flow) {
  return app.request(flow.callback.pathname + flow.callback.search, { headers: { Cookie: flow.transaction }, redirect: 'manual' });
}
const oidcEnv = issuer => ({ AUTH_MODE: 'oidc', OIDC_ISSUER_URL: issuer, OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_SECRET: 'TEST_ONLY_OIDC_SECRET', OIDC_ALLOWED_GROUPS: 'library-users', OIDC_ALLOW_HTTP_LOCALHOST: 'true' });

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: native OIDC verifies PKCE/signatures, persists opaque sessions, protects data and logs out`, { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL }, async t => {
    const op = await provider(t);
    const app = await startApp(t, { ...oidcEnv(op.issuer), ...(backend === 'postgres' ? { DATABASE_BACKEND: backend, DATABASE_URL: process.env.TEST_DATABASE_URL } : {}) });
    assert.equal((await app.request('/api/assets')).status, 401);
    assert.equal((await (await app.request('/auth/check')).json()).authenticated, false);
    const home = await app.request('/', { redirect: 'manual' }); assert.equal(home.status, 302); assert.match(home.headers.get('location'), /^\/auth\/login/);
    const flow = await begin(app, '/?categories=model'); const callback = await finish(app, flow);
    assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/?categories=model');
    let session = cookies(callback); assert.ok(session.includes('asset-library-session='));
    assert.match(callback.headers.getSetCookie().join(';'), /HttpOnly/); assert.match(callback.headers.getSetCookie().join(';'), /SameSite=Lax/);
    const identity = await (await app.request('/auth/check', { headers: { Cookie: session } })).json(); assert.equal(identity.authenticated, true); assert.equal(identity.user.subject, 'test-user');
    assert.equal((await app.request('/api/assets', { headers: { Cookie: session } })).status, 200);
    await app.restart(); assert.equal((await app.request('/api/assets', { headers: { Cookie: session } })).status, 200);
    const database = await createDatabase({ backend, sqlitePath: `${app.cwd}/data/assets.db`, connectionString: process.env.TEST_DATABASE_URL });
    t.after(() => database.close());
    const stored = await database.prepare('SELECT id_hash, user_json FROM auth_sessions WHERE user_json LIKE ?').all('%test-user%');
    assert.ok(stored.length > 0);
    assert.ok(stored.some(row => row.id_hash === createHash('sha256').update(session.split('=')[1]).digest('hex')));
    assert.ok(stored.every(row => row.id_hash !== session.split('=')[1] && !row.user_json.includes('TEST_ONLY_ACCESS_TOKEN')));
    const oldSession = session; const rotating = await begin(app);
    const rotated = await app.request(rotating.callback.pathname + rotating.callback.search, { headers: { Cookie: rotating.transaction + '; ' + session }, redirect: 'manual' });
    session = cookies(rotated); assert.notEqual(session, oldSession);
    assert.equal((await app.request('/api/assets', { headers: { Cookie: oldSession } })).status, 401);
    assert.equal((await finish(app, flow)).headers.get('location'), '/auth/error');
    assert.equal((await app.request('/auth/logout', { method: 'POST', headers: { Cookie: session, Origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await app.request('/api/assets', { headers: { Cookie: session } })).status, 200);
    const logout = await app.request('/auth/logout', { method: 'POST', headers: { Cookie: session }, redirect: 'manual' }); assert.equal(logout.status, 303); assert.equal(logout.headers.get('location'), '/auth/signed-out');
    assert.equal((await app.request('/api/assets', { headers: { Cookie: session } })).status, 401);
    const expiredFlow = await begin(app); const signedIn = await finish(app, expiredFlow); const expiring = cookies(signedIn);
    const id = expiring.split('=')[1]; await database.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id_hash = ?').run(Date.now() - 1000, createHash('sha256').update(id).digest('hex'));
    assert.equal((await app.request('/api/assets', { headers: { Cookie: expiring } })).status, 401);
  });
}

for (const invalid of ['state', 'nonce', 'signature', 'expired', 'audience', 'issuer', 'group']) {
  test(`native OIDC rejects invalid ${invalid}`, async t => {
    const op = await provider(t); op.mode(invalid);
    const app = await startApp(t, { ...oidcEnv(op.issuer), ...(invalid === 'group' ? { OIDC_ALLOWED_GROUPS: 'admins-only' } : {}) });
    const flow = await begin(app);
    if (invalid === 'state') flow.callback.searchParams.set('state', 'wrong-state');
    const result = await finish(app, flow); assert.equal(result.status, 303); assert.equal(result.headers.get('location'), '/auth/error');
    assert.ok(!cookies(result).includes('asset-library-session='));
    assert.equal((await app.request('/api/assets')).status, 401);
    if (invalid === 'state') assert.equal(op.exchanges(), 0);
  });
}

test('native OIDC uses secure host cookies, blocks callback without a transaction and sanitizes return URLs', async t => {
  const op = await provider(t); const app = await startApp(t, { ...oidcEnv(op.issuer), ORIGIN: 'https://localhost' });
  const flow = await begin(app, '/..//example.invalid/steal');
  assert.match(flow.login.headers.getSetCookie().join(';'), /__Host-asset-library-transaction=/); assert.match(flow.login.headers.getSetCookie().join(';'), /Secure/);
  const withoutCookie = await app.request(flow.callback.pathname + flow.callback.search, { redirect: 'manual' }); assert.equal(withoutCookie.headers.get('location'), '/auth/error');
  const result = await finish(app, flow); assert.equal(result.headers.get('location'), '/');
  assert.match(result.headers.getSetCookie().join(';'), /__Host-asset-library-session=/); assert.match(result.headers.getSetCookie().join(';'), /Secure/);
});
