import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const script = await readFile(new URL('../build/thumbnail-renderer/renderer.js', import.meta.url), 'utf8');
let active = false;
const server = createServer(async (request, response) => {
  if (request.url === '/health' && request.method === 'GET') { response.writeHead(200); response.end('ok'); return; }
  if (request.url !== '/render' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
  if (active) { response.writeHead(503); response.end(); return; }
  const extension = request.headers['x-model-extension'];
  if (!['obj', 'stl', 'fbx', 'glb', 'gltf'].includes(extension)) { response.writeHead(415); response.end(); return; }
  active = true; let browser; let stage = "input";
  const deadline = setTimeout(() => { void browser?.close(); request.destroy(); response.destroy(); }, 30_000);
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { response.writeHead(413); response.end(); return; }
      chunks.push(chunk);
    }
    stage = "launch";
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, env: { ...process.env, XDG_CONFIG_HOME: '/tmp/config', XDG_CACHE_HOME: '/tmp/cache' },
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    stage = "context";
    const context = await browser.newContext({ viewport: { width: 320, height: 320 }, serviceWorkers: 'block', javaScriptEnabled: true });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    await page.setContent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; img-src data: blob:; connect-src \'none\'"><canvas></canvas>');
    await page.addScriptTag({ content: script });
    stage = "render";
    const png = await page.evaluate(async ({ data, extension }) => window.AssetThumbnail.render(data, extension), { data: Buffer.concat(chunks).toString('base64'), extension });
    const bytes = Buffer.from(png, 'base64');
    if (bytes.length > 1024 * 1024) throw new Error('Oversized result');
    await browser.close(); browser = undefined; active = false;
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length }); response.end(bytes);
  } catch (error) {
    console.error(`Model renderer failed at stage: ${stage}`);
    // This opt-in is used only with the fixed, non-sensitive CI fixture.
    if (process.env.RENDERER_DIAGNOSTICS === 'ci-smoke') console.error(error instanceof Error ? error.message.slice(0, 4000) : 'Render failed');
    if (!response.headersSent && !response.destroyed) { response.writeHead(422); response.end('Unable to render model'); }
  } finally { clearTimeout(deadline); await browser?.close(); active = false; }
});
server.requestTimeout = 30_000;
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
