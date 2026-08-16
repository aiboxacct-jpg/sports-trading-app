// kalshiMarketProvider.js — LIVE Kalshi data source (read-only).
//
// Implements Kalshi's RSA-PSS request signing and read-only market fetches. It stays
// NOT VERIFIED until credentials are provided; it never invents a price.
//
// Auth (confirmed against Kalshi's API docs):
//   - Sign the string  `${timestampMs}${METHOD}${path}`  where path is the URL path
//     from the API root WITHOUT the query string (e.g. /trade-api/v2/markets).
//   - Algorithm: RSA-PSS, SHA-256, salt length = digest length (32 bytes). Base64.
//   - Send: KALSHI-ACCESS-KEY (key id), KALSHI-ACCESS-TIMESTAMP (ms), KALSHI-ACCESS-SIGNATURE.
//
// Credentials (never commit, never paste in chat — see .env.example / KALSHI_SETUP.md):
//   KALSHI_API_KEY_ID       the API key id
//   KALSHI_PRIVATE_KEY      the RSA private key PEM (inline), OR
//   KALSHI_PRIVATE_KEY_PATH path to the downloaded .pem file
//   KALSHI_BASE_URL         optional; defaults to production

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { MarketProvider } from './marketProvider.js';

export const KALSHI_PROD = 'https://api.elections.kalshi.com/trade-api/v2';
export const KALSHI_DEMO = 'https://external-api.demo.kalshi.co/trade-api/v2';

const NOT_CONFIGURED =
  '🔴 NOT VERIFIED — Kalshi live provider is not configured. Add KALSHI_API_KEY_ID and a ' +
  'private key (KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH). See KALSHI_SETUP.md.';

/** RSA-PSS/SHA-256 signature (base64) of the Kalshi auth string. Exported for testing. */
export function signKalshi(privateKeyPem, timestampMs, method, path) {
  return crypto
    .sign('sha256', Buffer.from(`${timestampMs}${method}${path}`), {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString('base64');
}

function loadPrivateKey({ privateKeyPem, privateKeyPath }) {
  if (privateKeyPem) return privateKeyPem;
  const p = privateKeyPath ?? process.env.KALSHI_PRIVATE_KEY_PATH;
  if (p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
  return process.env.KALSHI_PRIVATE_KEY ?? null;
}

export class KalshiMarketProvider extends MarketProvider {
  constructor({ apiKeyId, privateKeyPem, privateKeyPath, baseUrl } = {}) {
    super();
    this.apiKeyId = apiKeyId ?? process.env.KALSHI_API_KEY_ID ?? null;
    this.privateKeyPem = loadPrivateKey({ privateKeyPem, privateKeyPath });
    this.baseUrl = baseUrl ?? process.env.KALSHI_BASE_URL ?? KALSHI_PROD;
    this.prices = new Map(); // ticker -> last known price cents (from fetches)
  }

  get source() { return 'KALSHI'; }
  get verified() { return this.isConfigured; }
  get isConfigured() { return Boolean(this.apiKeyId && this.privateKeyPem); }

  /** Sync price accessor for the engine — returns cached value or null (NOT VERIFIED). */
  getPrice(ticker) {
    return this.prices.has(ticker) ? this.prices.get(ticker) : null;
  }

  assertConfigured() {
    if (!this.isConfigured) throw new Error(NOT_CONFIGURED);
  }

  /** Signed request to the Kalshi REST API. Returns parsed JSON. */
  async request(method, endpoint, { query } = {}) {
    this.assertConfigured();
    const url = new URL(this.baseUrl + endpoint);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    const ts = Date.now().toString();
    const signature = signKalshi(this.privateKeyPem, ts, method, url.pathname); // pathname excludes query
    const res = await fetch(url, {
      method,
      headers: {
        'KALSHI-ACCESS-KEY': this.apiKeyId,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Kalshi ${method} ${endpoint} → ${res.status} ${body}`.slice(0, 300));
    }
    return res.json();
  }

  /** Connectivity check — exchange status (proves auth works). */
  getExchangeStatus() {
    return this.request('GET', '/exchange/status');
  }

  /** List markets, optionally filtered to a series (e.g. an MLB game series). */
  async listMarkets({ seriesTicker, eventTicker, status = 'open', limit = 100 } = {}) {
    const { markets = [] } = await this.request('GET', '/markets', {
      query: { series_ticker: seriesTicker, event_ticker: eventTicker, status, limit },
    });
    for (const m of markets) this.#cache(m);
    return markets;
  }

  /** Fetch one market and cache its price. */
  async fetchMarket(ticker) {
    const { market } = await this.request('GET', `/markets/${ticker}`);
    if (market) this.#cache(market);
    return market;
  }

  #cache(market) {
    // Kalshi prices are integer cents (1..99). Prefer last_price, fall back to the mid.
    const price = market.last_price ?? (market.yes_bid != null && market.yes_ask != null
      ? Math.round((market.yes_bid + market.yes_ask) / 2)
      : market.yes_bid ?? null);
    if (market.ticker && price != null) this.prices.set(market.ticker, price);
  }
}

export { NOT_CONFIGURED };
