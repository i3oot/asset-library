import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { provider } from './oidc-provider.mjs';
import { startApp } from './helpers.mjs';

test('browser completes native login, protects data and submits logout with a same-origin Origin', { skip: !process.env.TEST_CHROMIUM_PATH }, async t => {
  const op = await provider(t);
  const app = await startApp(t, {
    AUTH_MODE: 'oidc', OIDC_ISSUER_URL: op.issuer,
    OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_SECRET: 'TEST_ONLY_OIDC_SECRET',
    OIDC_ALLOWED_GROUPS: 'library-users', OIDC_ALLOW_HTTP_LOCALHOST: 'true',
  });
  const browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const unexpected = [], errors = [];
  await context.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    if ([app.origin, new URL(op.issuer).origin].includes(origin)) return route.continue();
    unexpected.push(origin); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  assert.equal((await context.request.get(app.origin + '/api/assets')).status(), 401);
  await page.goto(app.origin);
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  assert.ok(await page.getByText('Test User', { exact: true }).isVisible());
  assert.equal((await context.request.get(app.origin + '/api/assets')).status(), 200);
  const session = (await context.cookies()).find(cookie => cookie.name === 'asset-library-session');
  assert.ok(session?.httpOnly); assert.equal(session.sameSite, 'Lax');
  assert.ok(!(await page.evaluate(() => document.cookie)).includes('asset-library-session'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(app.origin + '/auth/signed-out');
  assert.equal((await context.request.get(app.origin + '/api/assets')).status(), 401);
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
});
