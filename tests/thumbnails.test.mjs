import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import sharp from 'sharp';
import { thumbHashToDataURL } from 'thumbhash';
import { startApp } from './helpers.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { signRenderRequest } from '../renderer/request-auth.mjs';

async function upload(app, bytes, filename, mimeType) {
  const form = new FormData(); form.set('title', filename); form.set('file', new Blob([bytes], { type: mimeType }), filename);
  const response = await app.request('/api/assets', { method: 'POST', body: form });
  assert.equal(response.status, 201); return (await response.json()).asset;
}

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend}: server image thumbnails, hash persistence, replacement and no client poster writes`, { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL }, async t => {
    const app = await startApp(t, backend === 'postgres' ? { DATABASE_BACKEND: backend, DATABASE_URL: process.env.TEST_DATABASE_URL } : {});
    const image = await sharp({ create: { width: 1000, height: 500, channels: 4, background: '#69b0d2' } }).png().toBuffer();
    const asset = await upload(app, image, 'image.png', 'image/png');
    assert.ok(asset.thumbhash); assert.ok(asset.thumbnailUrl);
    assert.match(thumbHashToDataURL(Buffer.from(asset.thumbhash, 'base64')), /^data:image\/png;base64,/);
    const thumbnail = await app.request(asset.thumbnailUrl); assert.equal(thumbnail.status, 200);
    const metadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
    assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 320); assert.equal(metadata.height, 160);
    const forged = await app.request(asset.thumbnailUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png', 'If-Match': asset.hash }, body: image });
    assert.equal(forged.status, 405);
    await app.restart();
    const list = await (await app.request('/api/assets')).json(); assert.equal(list.assets.find(row => row.id === asset.id).thumbhash, asset.thumbhash);
    const replacement = new FormData(); replacement.set('file', new Blob(['plain text']), 'plain.txt');
    const replaced = await app.request(`/api/assets/${asset.id}/file`, { method: 'PATCH', body: replacement });
    assert.equal(replaced.status, 200); assert.equal((await replaced.json()).asset.thumbhash, undefined);
    assert.equal((await app.request(asset.thumbnailUrl)).status, 404);
    await app.request(`/api/assets/${asset.id}`, { method: 'DELETE' });
  });
}

test('3D poster and ThumbHash are rendered on the server; model references cannot make external requests', { skip: !process.env.TEST_CHROMIUM_PATH }, async t => {
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const renderer = spawn(process.execPath, ['renderer/server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CHROMIUM_PATH: process.env.TEST_CHROMIUM_PATH, RENDERER_REQUIRE_SIGNATURE: 'true', RENDERER_PUBLIC_KEY: publicKey }, stdio: 'ignore' });
  t.after(async () => { if (renderer.exitCode === null) { const done = once(renderer, 'exit'); renderer.kill(); await done; } });
  const rendererUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(rendererUrl + '/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  const app = await startApp(t, { MODEL_THUMBNAIL_URL: rendererUrl, MODEL_THUMBNAIL_SIGNING_KEY: privateKey });
  const obj = 'v -1 -1 0\nv 1 -1 0\nv 0 1 0\nf 1 2 3\n';
  const unsigned = await fetch(rendererUrl + '/render', { method: 'POST', headers: { 'X-Model-Extension': 'obj' }, body: obj });
  assert.equal(unsigned.status, 401);
  const asset = await upload(app, obj, 'triangle.obj', 'text/plain');
  assert.equal(asset.previewKind, 'model'); assert.ok(asset.thumbhash); assert.ok(asset.thumbnailUrl);
  const poster = await app.request(asset.thumbnailUrl); assert.equal(poster.status, 200);
  const metadata = await sharp(Buffer.from(await poster.arrayBuffer())).metadata(); assert.equal(metadata.width, 320); assert.equal(metadata.height, 320);
  assert.equal((await app.request(asset.thumbnailUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png', 'If-Match': asset.hash }, body: 'forged poster' })).status, 405);
  const malicious = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ uri: 'http://127.0.0.1:1/forbidden.bin', byteLength: 36 }] });
  const signed = signRenderRequest(Buffer.from(malicious), 'gltf', privateKey);
  const blocked = await fetch(rendererUrl + '/render', { method: 'POST', headers: { 'X-Model-Extension': 'gltf', ...signed }, body: malicious });
  assert.equal(blocked.status, 422);
  const replayed = await fetch(rendererUrl + '/render', { method: 'POST', headers: { 'X-Model-Extension': 'gltf', ...signed }, body: malicious });
  assert.equal(replayed.status, 401);
});
