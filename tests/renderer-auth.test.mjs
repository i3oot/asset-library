import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { signRenderRequest, renderVerifier } from '../renderer/request-auth.mjs';

test('renderer verifies signed bytes, format, freshness and single-use nonces using only a public key', () => {
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => renderVerifier(undefined, true));
  const verifier = renderVerifier(publicKey, true), bytes = Buffer.from('fixture');
  const now = Date.now();
  const headers = Object.fromEntries(Object.entries(signRenderRequest(bytes, 'obj', privateKey, now)).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(verifier.headersPresent({}), false);
  assert.equal(verifier.verify(Buffer.from('tampered'), 'obj', headers, now), false);
  assert.equal(verifier.verify(bytes, 'gltf', headers, now), false);
  assert.equal(verifier.verify(bytes, 'obj', headers, now + 61_000), false);
  assert.equal(verifier.verify(bytes, 'obj', headers, now), true);
  assert.equal(verifier.verify(bytes, 'obj', headers, now), false);
  const attacker = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const forged = Object.fromEntries(Object.entries(signRenderRequest(bytes, 'obj', attacker)).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(verifier.verify(bytes, 'obj', forged), false);
});
