import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8080';
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
const response = await fetch(base + '/render', { method: 'POST', headers: { 'X-Model-Extension': 'obj' }, body: 'v -1 -1 0\nv 1 -1 0\nv 0 1 0\nf 1 2 3\n', signal: AbortSignal.timeout(45_000) });
assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
const bytes = new Uint8Array(await response.arrayBuffer()); assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
console.log('Isolated container rendered a model to PNG successfully.');
