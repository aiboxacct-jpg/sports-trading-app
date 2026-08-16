import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { signKalshi, KalshiMarketProvider } from '../src/data/kalshiMarketProvider.js';

const pssVerify = (publicKey, msg, sigB64) =>
  crypto.verify('sha256', Buffer.from(msg), {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, Buffer.from(sigB64, 'base64'));

test('signKalshi produces a valid RSA-PSS/SHA-256 signature over ts+method+path', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const ts = '1700000000000', method = 'GET', path = '/trade-api/v2/markets';

  const sig = signKalshi(pem, ts, method, path);
  assert.ok(typeof sig === 'string' && sig.length > 0);
  assert.equal(pssVerify(publicKey, `${ts}${method}${path}`, sig), true);
  // a tampered message must not verify against the same signature
  assert.equal(pssVerify(publicKey, `${ts}POST${path}`, sig), false);
});

test('unconfigured Kalshi provider is NOT VERIFIED and never invents a price', () => {
  const k = new KalshiMarketProvider({ apiKeyId: null, privateKeyPem: null, baseUrl: 'https://x' });
  assert.equal(k.isConfigured, false);
  assert.equal(k.verified, false);
  assert.equal(k.getPrice('ANY'), null);
  assert.throws(() => k.assertConfigured());
});

test('configured Kalshi provider reports verified + ready to sign', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const k = new KalshiMarketProvider({ apiKeyId: 'test-key-id', privateKeyPem: pem, baseUrl: 'https://x' });
  assert.equal(k.isConfigured, true);
  assert.equal(k.verified, true);
  assert.equal(k.source, 'KALSHI');
});
