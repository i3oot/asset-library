import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

/** @param {Uint8Array} bytes @param {string} extension @param {string} timestamp @param {string} nonce */
function message(bytes, extension, timestamp, nonce) {
  return Buffer.from(`asset-library-render-v1\nPOST\n/render\n${extension}\n${timestamp}\n${nonce}\n${createHash('sha256').update(bytes).digest('hex')}`);
}

/** @param {Uint8Array} bytes @param {string} extension @param {string} privateKey @param {number} [now] */
export function signRenderRequest(bytes, extension, privateKey, now = Date.now()) {
  const timestamp = String(now), nonce = randomBytes(16).toString('base64url');
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Rendering requires an Ed25519 signing key');
  return {
    'X-Render-Timestamp': timestamp, 'X-Render-Nonce': nonce,
    'X-Render-Signature': sign(null, message(bytes, extension, timestamp, nonce), key).toString('base64url'),
  };
}

/** @param {string | undefined} publicKey @param {boolean} required */
export function renderVerifier(publicKey, required) {
  if (required && !publicKey) throw new Error('Renderer signature verification key is required');
  const key = publicKey ? createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }) : undefined;
  if (key && key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid renderer verification key');
  const seen = new Map();
  /** @param {import('node:http').IncomingHttpHeaders} headers */
  function headersPresent(headers) {
    const nonce = headers['x-render-nonce'];
    return !key || ([headers['x-render-timestamp'], nonce, headers['x-render-signature']].every(value => typeof value === 'string') && !seen.has(nonce));
  }
  return {
    headersPresent,
    /** @param {Uint8Array} bytes @param {string} extension @param {import('node:http').IncomingHttpHeaders} headers @param {number} [now] */
    verify(bytes, extension, headers, now = Date.now()) {
      if (!key) return true;
      const timestamp = headers['x-render-timestamp'], nonce = headers['x-render-nonce'], signature = headers['x-render-signature'];
      if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 ||
          typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(nonce) ||
          typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
      for (const [value, expiry] of seen) if (expiry <= now) seen.delete(value);
      if (seen.has(nonce) || seen.size >= 4096 || !verify(null, message(bytes, extension, timestamp, nonce), key, Buffer.from(signature, 'base64url'))) return false;
      seen.set(nonce, now + 120_000);
      return true;
    },
  };
}
