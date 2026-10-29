import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { startApp } from './helpers.mjs';
import { provider } from './oidc-provider.mjs';

test('authenticated browser asks new-version/replace/cancel and displays immutable history', { skip: !process.env.TEST_CHROMIUM_PATH }, async t => {
  const op = await provider(t);
  const app = await startApp(t, { AUTH_MODE: 'oidc', OIDC_ISSUER_URL: op.issuer, OIDC_CLIENT_ID: 'test-client',
    OIDC_CLIENT_SECRET: 'TEST_ONLY_OIDC_SECRET', OIDC_ALLOWED_GROUPS: 'library-users', OIDC_ALLOW_HTTP_LOCALHOST: 'true' });
  const browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_PATH, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage(); const errors = [];
  const mutationMethods = [];
  page.on('request', request => {
    if (request.url().includes('/api/assets') && !['GET', 'HEAD'].includes(request.method())) mutationMethods.push(request.method());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.origin); await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  async function select(text) {
    // The top-level picker is outside the metadata dialog.
    await page.locator('input[type=file]').first().setInputFiles({ name: 'history.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
    await page.getByRole('button', { name: 'Queue Files', exact: true }).click();
  }
  await select('version one');
  await page.getByRole('heading', { name: 'history', exact: true }).waitFor();
  await select('version two');
  await page.getByRole('dialog', { name: 'Choose upload version' }).waitFor();
  await page.getByRole('button', { name: 'Save New Version', exact: true }).click();
  let asset;
  async function waitForChanges(count) {
    for (let n = 0; n < 50; n++) {
      asset = (await (await page.request.get(app.origin + '/api/assets')).json()).assets[0];
      const result = await (await page.request.get(app.origin + `/api/assets/${asset.id}/versions`)).json();
      if (result.total === count) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`History did not reach ${count} changes`);
  }
  await waitForChanges(2);
  await page.locator('article.assetlib-card').hover();
  await page.getByRole('button', { name: 'Edit metadata', exact: true }).click();
  await page.getByRole('button', { name: 'Version History', exact: true }).click();
  await page.getByRole('heading', { name: 'Version 2 · new-version · Change #2', exact: true }).waitFor();
  assert.ok(await page.getByText('Test User', { exact: false }).count());
  // Native dialog defaults can disagree with the application's theme.
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const colors = await page.getByRole('dialog', { name: 'Asset version history' }).evaluate(element => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor, link: getComputedStyle(element.querySelector('a')).color };
    });
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    for (const foreground of [colors.foreground, colors.link]) {
      const values = [luminance(foreground), luminance(colors.background)].sort((a, b) => a - b);
      assert.ok((values[1] + 0.05) / (values[0] + 0.05) >= 4.5, `${theme} history text/link contrast is too low`);
    }
  }
  await page.getByRole('button', { name: 'Close History', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit asset metadata' }).locator('input[type=file]').setInputFiles({ name: 'history.txt', mimeType: 'text/plain', buffer: Buffer.from('corrected version two') });
  await page.getByRole('button', { name: 'Replace Current', exact: true }).click();
  // Use the authenticated HTTP context only to wait for the mutation, never manufacture a session.
  await waitForChanges(3);
  const history = await (await page.request.get(app.origin + `/api/assets/${asset.id}/versions`)).json();
  assert.deepEqual(history.revisions.map(row => row.version), [2, 2, 1]);
  assert.equal(history.revisions[0].actor.name, 'Test User');
  assert.ok(!('email' in history.revisions[0].actor));
  assert.equal(await (await page.request.get(app.origin + history.revisions[2].asset.downloadUrl)).text(), 'version one');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await select('cancelled upload');
  await page.getByRole('button', { name: 'Cancel Upload', exact: true }).click();
  assert.equal((await (await page.request.get(app.origin + `/api/assets/${asset.id}/versions`)).json()).total, 3);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(app.origin + '/auth/signed-out');
  assert.equal((await page.request.get(app.origin + history.revisions[2].asset.downloadUrl)).status(), 401);
  assert.ok(mutationMethods.length >= 3);
  assert.ok(mutationMethods.every(method => method === 'POST'));
  assert.deepEqual(errors, []);
});
