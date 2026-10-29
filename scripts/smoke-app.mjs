import assert from 'node:assert/strict';
import sharp from 'sharp';
const base = 'http://127.0.0.1:3000';
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/assets')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
const image = await sharp({ create: { width: 500, height: 300, channels: 4, background: '#789abc' } }).png().toBuffer();
const form = new FormData(); form.set('title', 'Container test'); form.set('file', new Blob([image], { type: 'image/png' }), 'sample.png');
const uploaded = await fetch(base + '/api/assets', { method: 'POST', headers: { Origin: base }, body: form }); assert.equal(uploaded.status, 201);
const { asset } = await uploaded.json(); assert.ok(asset.thumbhash); assert.ok(asset.thumbnailUrl);
const thumbnail = await fetch(base + asset.thumbnailUrl); assert.equal(thumbnail.status, 200);
const metadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata(); assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 320);
console.log('App container generated and served an image thumbnail and ThumbHash successfully.');
