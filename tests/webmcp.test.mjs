import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { startApp } from './helpers.mjs';
import { provider } from './oidc-provider.mjs';

test('native WebMCP exposes authenticated library tools and enforces bounded same-origin operations', { skip: !process.env.TEST_CHROMIUM_PATH }, async t => {
  const op = await provider(t);
  const app = await startApp(t, { AUTH_MODE: 'oidc', OIDC_ISSUER_URL: op.issuer,
    OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_SECRET: 'TEST_ONLY_OIDC_SECRET',
    OIDC_ALLOWED_GROUPS: 'library-users', OIDC_ALLOW_HTTP_LOCALHOST: 'true' });
  const browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_PATH, headless: true,
    args: ['--no-sandbox', '--enable-features=WebMCP'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.origin + '/auth/signed-out');
  assert.deepEqual(await page.webmcp.tools(), []);
  await page.goto(app.origin);
  let tools = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    tools = await page.webmcp.tools();
    if (tools.length === 7) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(tools.length, 7);
  assert.ok(tools.every(tool => tool.name.startsWith('asset_library_')));
  assert.ok(!tools.some(tool => /delete|config|secret/.test(tool.name)));
  const call = (name, input = {}) => page.webmcp.callTool('asset_library_' + name, input);
  assert.equal((await call('search')).result.total, 0);
  const imported = await call('import_text', { filename: 'sample.lua', title: 'Example script', text: 'print("hello")', licenses: ['MIT'], tags: ['fixture'] });
  assert.equal(imported.ok, true);
  const asset = imported.result;
  assert.ok(asset.id);
  assert.ok(!('storedName' in asset));
  assert.equal((await call('search', { tags: ['fixture'] })).result.total, 1);
  assert.equal((await call('get_asset', { id: asset.id })).result.title, 'Example script');
  const text = await call('read_text', { id: asset.id, maxChars: 5 });
  assert.equal(text.result.text, 'print'); assert.equal(text.result.truncated, true);
  const changed = await call('update_metadata', { id: asset.id, title: 'Renamed script' });
  assert.equal(changed.result.title, 'Renamed script');
  assert.deepEqual(changed.result.tags, ['fixture']);
  assert.deepEqual(changed.result.licenses, ['MIT']);
  const history = await call('history', { id: asset.id });
  assert.equal(history.result.total, 2);
  assert.equal(history.result.revisions[0].operation, 'metadata');
  const conflicting = await call('import_text', { filename: 'sample.lua', title: 'Should not replace', text: 'new content', licenses: ['MIT'] });
  assert.equal(conflicting.error.code, 'upload_conflict');
  assert.equal(conflicting.error.details[0].revision, 2);
  const updatedFile = await call('import_text', { filename: 'sample.lua', title: 'Preserve existing metadata', text: 'new content', licenses: ['MIT'], targetAssetId: asset.id, mode: 'new-version', expectedRevision: 2, note: 'New release' });
  assert.equal(updatedFile.ok, true);
  assert.equal(updatedFile.result.title, 'Renamed script');
  assert.equal((await call('history', { id: asset.id })).result.revisions[0].version, 2);
  assert.equal((await call('read_text', { id: asset.id, revision: 1 })).result.text, 'print("hello")');
  assert.equal((await call('read_text', { id: asset.id })).result.text, 'new content');
  const stale = await call('import_text', { filename: 'sample.lua', title: 'Stale', text: 'stale content', licenses: ['MIT'], targetAssetId: asset.id, mode: 'replace', expectedRevision: 2 });
  assert.equal(stale.error.code, 'revision_conflict');
  await call('show_asset', { id: asset.id });
  await page.getByRole('dialog').waitFor();
  assert.equal((await call('get_asset', { id: 'missing' })).error.code, 'not_found');
  // Native validation may reject before execute; either way invalid input must never reach an API.
  for (const [name, input] of [
    ['get_asset', { id: '../integrations/ai' }], ['search', { limit: 1000 }],
    ['update_metadata', { id: asset.id, sourceUrl: 'https://user:password@example.com' }],
    ['update_metadata', { id: asset.id, licenses: [] }],
    ['get_asset', { id: asset.id, secret: true }],
    ['import_text', { filename: '../../bad.lua', title: 'bad', text: 'x', licenses: ['MIT'] }],
  ]) {
    let result;
    try { result = await call(name, input); } catch { continue; }
    assert.equal(result.error.code, 'invalid_arguments');
  }
  assert.equal((await call('search')).result.total, 1);
  // Expiring the session leaves no unauthenticated API path through a registered tool.
  await page.context().clearCookies();
  assert.equal((await call('search')).error.code, 'authentication_required');
  await page.goto(app.origin + '/auth/signed-out');
  assert.deepEqual(await page.webmcp.tools(), []);
  assert.deepEqual(errors, []);
});

test('library remains usable when WebMCP is disabled', { skip: !process.env.TEST_CHROMIUM_PATH }, async t => {
  const app = await startApp(t);
  const browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_PATH, headless: true,
    args: ['--no-sandbox', '--disable-features=WebMCP'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.origin);
  const notice = page.locator('.agent-support-toast');
  await page.getByText('Agent tools unavailable', { exact: true }).waitFor();
  assert.equal(await page.locator('.agent-tools-status').count(), 0);
  await notice.locator('[data-close-button]').click();
  await notice.waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('heading', { name: 'Asset Library', exact: true }).waitFor();
  assert.equal(await notice.count(), 0);
  assert.ok(await page.locator('input[type="file"]').count());
  assert.deepEqual(errors, []);
});
