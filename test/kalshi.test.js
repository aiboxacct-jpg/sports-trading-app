import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { signKalshi, KalshiMarketProvider, dollarsToCents, normalizeMarket, mlbTickerDate, mlbTickerGameNumber } from '../src/data/kalshiMarketProvider.js';

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

test('mlbTickerDate reads the reliable game date from the ticker', () => {
  assert.equal(mlbTickerDate('KXMLBGAME-26AUG161920SEAHOU-SEA'), '2026-08-16');
  assert.equal(mlbTickerDate('KXMLBGAME-26AUG171340STLCING1-STL'), '2026-08-17');
  assert.equal(mlbTickerDate('KXMLBGAME-25DEC0159XYZ-YES'), '2025-12-01');
  assert.equal(mlbTickerDate('NOT-A-GAME'), null);
  assert.equal(mlbTickerDate(null), null);
});

test('mlbTickerGameNumber tells doubleheader games apart (and ignores dates)', () => {
  assert.equal(mlbTickerGameNumber('KXMLBGAME-26AUG171340STLCING1-STL'), 1);
  assert.equal(mlbTickerGameNumber('KXMLBGAME-26AUG171840STLCING2-CIN'), 2);
  assert.equal(mlbTickerGameNumber('KXMLBGAME-26AUG171340STLCING1'), 1); // event ticker, no side
  assert.equal(mlbTickerGameNumber('KXMLBGAME-26AUG191840STLCIN-STL'), null); // single game
  assert.equal(mlbTickerGameNumber('KXMLBGAME-26AUG161920SEAHOU-SEA'), null); // "AUG16"/"G19" not end-matched
});

test('dollarsToCents parses the API dollar strings, never invents on blanks', () => {
  assert.equal(dollarsToCents('0.4700'), 47);
  assert.equal(dollarsToCents('1.0000'), 100);
  assert.equal(dollarsToCents('0.0100'), 1);
  assert.equal(dollarsToCents(''), null);
  assert.equal(dollarsToCents(null), null);
  assert.equal(dollarsToCents(undefined), null);
});

test('normalizeMarket reads *_dollars fields into cents and picks a sane price', () => {
  const m = normalizeMarket({
    ticker: 'KXMLBGAME-X-LAD', event_ticker: 'KXMLBGAME-X', title: 'LAD vs COL Winner?',
    yes_sub_title: 'Los Angeles D', status: 'active',
    yes_bid_dollars: '0.4500', yes_ask_dollars: '0.4900', last_price_dollars: '0.4700',
    volume_fp: '12.00',
  });
  assert.equal(m.team, 'Los Angeles D');
  assert.equal(m.bidCents, 45);
  assert.equal(m.askCents, 49);
  assert.equal(m.lastCents, 47);
  assert.equal(m.midCents, 47);
  assert.equal(m.priceCents, 47); // prefers last trade
  assert.equal(m.hasLiquidity, true);
});

test('normalizeMarket treats 0/100 placeholders as absent (no invented price)', () => {
  // Demo-style row: no trade (0), no ask (100), only a bid — price falls back to bid.
  const m = normalizeMarket({
    ticker: 'T', event_ticker: 'E', yes_sub_title: 'A',
    yes_bid_dollars: '0.5300', yes_ask_dollars: '1.0000', last_price_dollars: '0.0000',
    volume_fp: '0.00',
  });
  assert.equal(m.lastCents, null); // 0 => no trade yet
  assert.equal(m.askCents, null);  // 100 => no real ask
  assert.equal(m.bidCents, 53);
  assert.equal(m.priceCents, 53);  // falls through to the bid
  assert.equal(m.hasLiquidity, false); // vol 0 and not two-sided
});
