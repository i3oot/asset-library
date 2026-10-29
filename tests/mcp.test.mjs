import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from './helpers.mjs';
import { isolatedPostgres } from './isolated-postgres.mjs';

async function fixture(t, database = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let issuer;
  const provider = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') res.end(JSON.stringify({ issuer, jwks_uri: issuer + 'jwks' }));
    else if (req.url === '/jwks') res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] }));
    else { res.writeHead(404); res.end(); }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  issuer = `http://127.0.0.1:${provider.address().port}/`;
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  const resource = 'https://mcp.example.invalid/mcp';
  const app = await startApp(t, { ...database, AUTH_MODE: 'oidc', OIDC_ISSUER_URL: issuer, OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_SECRET: 'TEST_ONLY_OIDC_SECRET', OIDC_ALLOW_HTTP_LOCALHOST: 'true', MCP_ENABLED: 'true', MCP_RESOURCE_URL: resource, MCP_OIDC_ISSUER_URL: issuer });
  function token(overrides = {}, wrongSignature = false) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: resource, sub: 'fixture-user', name: 'Fixture User', iat: now, exp: now + 900, azp: resource, uid: 'fixture-access-token', scope: 'assets:read assets:write', ...overrides };
    const input = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
    return input + '.' + sign('RSA-SHA256', Buffer.from(input), wrongSignature ? other.privateKey : privateKey).toString('base64url');
  }
  async function client(access = token()) {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', app.origin), { requestInit: { headers: { Authorization: 'Bearer ' + access } } });
    const client = new Client({ name: 'regression-test', version: '1.0.0' });
    await client.connect(transport); t.after(() => client.close()); return client;
  }
  return { app, token, client, resource, issuer };
}
const unpack = response => JSON.parse(response.content[0].text);

test('MCP OAuth metadata, challenge, cryptographic resource binding and cookie isolation', async t => {
  const { app, token, client, resource, issuer } = await fixture(t);
  const metadata = await fetch(app.origin + '/.well-known/oauth-protected-resource/mcp');
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).authorization_servers, [issuer]);
  for (const headers of [{}, { Cookie: 'asset-library-session=not-an-access-token' }, { Authorization: 'Bearer invalid' }]) {
    const response = await fetch(app.origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
    assert.equal(response.headers.get('location'), null);
  }
  for (const [claims, wrong] of [
    [{ aud: 'https://other.invalid/mcp' }], [{ iss: issuer + 'wrong' }], [{ exp: 1 }], [{ scope: 'assets:write' }], [{ uid: undefined, scope: undefined, azp: undefined }], [{ azp: 'wrong-client' }], [{ exp: Math.floor(Date.now() / 1000) + 3600 }], [{}, true],
  ]) {
    assert.equal((await fetch(app.origin + '/mcp', { headers: { Authorization: 'Bearer ' + token(claims, wrong) } })).status, 401);
  }
  const authorization = 'Bearer ' + token();
  assert.equal((await fetch(app.origin + '/mcp', { method: 'POST', headers: { authorization, origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(app.origin + '/mcp', { headers: { authorization } })).status, 405);
  assert.equal((await fetch(app.origin + '/api/assets', { headers: { authorization } })).status, 401);
  const full = await client(); const readonly = await client(token({ scope: 'assets:read' }));
  assert.equal((await full.listTools()).tools.length, 7);
  assert.equal((await readonly.listTools()).tools.length, 5);
  await assert.rejects(readonly.callTool({ name: 'asset_library_import_text', arguments: { filename: 'bad.txt', title: 'bad', text: 'bad', licenses: ['CC0'] } }), /not found/);
  const found = unpack(await full.callTool({ name: 'asset_library_search', arguments: {} }));
  assert.equal(found.result.total, 0);
  assert.equal((await full.callTool({ name: 'asset_library_get_asset', arguments: { id: '../secret' } })).isError, true);
  assert.equal((await full.callTool({ name: 'asset_library_search', arguments: { url: 'http://evil.invalid' } })).isError, true);
  assert.equal((await fetch(app.origin + '/auth/mcp/check', { headers: { authorization } })).status, 200);
  assert.equal((await fetch(app.origin + '/.well-known/oauth-protected-resource')).status, 200);
  assert.equal(resource, 'https://mcp.example.invalid/mcp');
});

for (const backend of ['sqlite', 'postgres']) {
  test(`MCP ${backend} imports, explicit version choice, history, actor and concurrent edit protection`, { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL }, async t => {
    const database = backend === 'postgres' ? { DATABASE_BACKEND: 'postgres', DATABASE_URL: await isolatedPostgres(t) } : {};
    const { client, app } = await fixture(t, database); const c = await client();
    const call = async (name, args) => unpack(await c.callTool({ name: 'asset_library_' + name, arguments: args }));
    const input = { filename: 'example.lua', title: 'Example', text: 'return 1', licenses: ['CC0'], tags: ['test'] };
    const created = await call('import_text', input); assert.equal(created.ok, true); const id = created.result.id;
    assert.equal('storedName' in created.result, false); assert.ok(created.result.downloadUrl.startsWith(app.origin));
    const conflict = await call('import_text', input); assert.equal(conflict.error.code, 'upload_conflict'); assert.equal(conflict.error.matches[0].revision, 1);
    assert.equal((await call('import_text', { ...input, text: 'return 2', targetAssetId: id })).error.code, 'invalid_arguments');
    assert.equal((await call('import_text', { ...input, text: 'return 2', targetAssetId: id, mode: 'new-version', expectedRevision: 1 })).ok, true);
    const history = (await call('history', { id })).result;
    assert.equal(history.total, 2); assert.equal(history.revisions[0].version, 2); assert.equal(history.revisions[0].actor.subject, 'fixture-user');
    assert.match(history.revisions[1].asset.downloadUrl, /versions\/1\/download$/);
    assert.equal((await call('read_text', { id, revision: 1 })).result.text, 'return 1');
    assert.equal((await call('read_text', { id })).result.text, 'return 2');
    assert.equal((await call('update_metadata', { id, title: 'Stale', expectedRevision: 1 })).error.code, 'revision_conflict');
    assert.equal((await call('update_metadata', { id, title: 'Edited', expectedRevision: 2 })).ok, true);
    assert.equal((await call('get_asset', { id })).result.licenses[0], 'CC0');
    const races = await Promise.all(['A', 'B'].map(title => call('update_metadata', { id, title, expectedRevision: 3 })));
    assert.equal(races.filter(r => r.ok).length, 1); assert.equal(races.filter(r => r.error?.code === 'revision_conflict').length, 1);
    assert.equal((await call('history', { id })).result.total, 4);
    assert.equal((await call('read_text', { id, maxChars: 3 })).result.truncated, true);
    assert.equal((await call('get_preview', { id })).error.code, 'unsupported_preview');
    assert.equal((await call('import_text', { ...input, filename: 'large.txt', text: '😀'.repeat(70000) })).error.code, 'too_large');
  });
}
