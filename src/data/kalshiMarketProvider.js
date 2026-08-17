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

/** Kalshi's MLB "game winner" series (each event = one game, one market per team side). */
export const KALSHI_MLB_SERIES = 'KXMLBGAME';

/**
 * Kalshi's v2 API returns money as dollar STRINGS ("0.4700"), not integer cents.
 * Convert to integer cents; return null for missing/blank so we never invent a price.
 */
export function dollarsToCents(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Normalize a raw Kalshi market into the fields the app cares about, in integer cents.
 * Reads the `*_dollars` fields (current API), falling back to legacy integer-cent fields.
 * bid/ask/last are the YES side; a null price means NOT VERIFIED, never a guess.
 */
export function normalizeMarket(m) {
  // A real Kalshi quote sits in 1..99¢. 0 or 100 are placeholders ("no bid" / "no ask"
  // / "no trade yet") — treat those as absent so we never show an invented price.
  const real = (c) => (c != null && c >= 1 && c <= 99 ? c : null);
  const bid = real(dollarsToCents(m.yes_bid_dollars) ?? m.yes_bid);
  const ask = real(dollarsToCents(m.yes_ask_dollars) ?? m.yes_ask);
  const last = real(dollarsToCents(m.last_price_dollars) ?? m.last_price);
  const mid = bid != null && ask != null ? Math.round((bid + ask) / 2) : null;
  const volume = Number(m.volume_fp ?? m.volume ?? 0) || 0;
  return {
    ticker: m.ticker,
    eventTicker: m.event_ticker ?? null,
    title: m.title ?? null,
    team: m.yes_sub_title ?? null, // the YES side this market pays on
    status: m.status ?? null,
    bidCents: bid,
    askCents: ask,
    lastCents: last,
    midCents: mid,
    // Best single "price" to show. Prefer the two-sided MID — that's what Kalshi's
    // headline % reflects and it tracks a live market far better than the last trade,
    // which lags. Fall back to last trade, then a one-sided quote.
    priceCents: mid ?? last ?? bid ?? ask ?? null,
    volume,
    // Genuine tradeable market: either it has traded, or it shows a real two-sided quote.
    hasLiquidity: volume > 0 || (bid != null && ask != null),
    // When the game is scheduled to start (best for "today's slate"); close is the
    // market's expiry, which can be days later to cover postponements.
    occurrenceTime: m.occurrence_datetime ?? null,
    closeTime: m.close_time ?? m.expected_expiration_time ?? null,
  };
}

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
    this.lastServerTimeMs = null; // authoritative "now" from Kalshi's HTTP Date header
  }

  get source() { return 'KALSHI'; }
  get verified() { return this.isConfigured; }
  get isConfigured() { return Boolean(this.apiKeyId && this.privateKeyPem); }

  /**
   * Best-known current time in ms. Prefers Kalshi's server clock (from the last response's
   * Date header) over the local clock, which may be wrong on the host machine — that skew
   * is exactly what made a live game look "not started yet".
   */
  serverNow() { return this.lastServerTimeMs ?? Date.now(); }

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
    const dateHeader = res.headers.get('date');
    if (dateHeader) { const t = Date.parse(dateHeader); if (!Number.isNaN(t)) this.lastServerTimeMs = t; }
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

  /**
   * List MLB "game winner" markets, grouped into games. Each game pairs the two team
   * sides (home/away) with real YES prices in cents and a VERIFIED flag when priced.
   *
   * Optionally scope to a time window around now (hours behind/ahead of the scheduled
   * start) so callers can show just "today's slate" instead of every listed day.
   */
  async listMlbGames({ status = 'open', limit = 300, withinHoursAhead, withinHoursBehind = 6 } = {}) {
    const markets = await this.listMarkets({ seriesTicker: KALSHI_MLB_SERIES, status, limit });
    const byEvent = new Map();
    for (const raw of markets) {
      const m = normalizeMarket(raw);
      if (!m.eventTicker) continue;
      if (!byEvent.has(m.eventTicker)) byEvent.set(m.eventTicker, []);
      byEvent.get(m.eventTicker).push(m);
    }
    let games = [];
    for (const [eventTicker, sides] of byEvent) {
      games.push({
        eventTicker,
        title: sides[0]?.title ?? null,
        occurrenceTime: sides[0]?.occurrenceTime ?? null,
        closeTime: sides[0]?.closeTime ?? null,
        sides, // one entry per team, each with team/priceCents/bid/ask/verified
        // A game is "priced" only if at least one side has a real (non-placeholder) quote.
        priced: sides.some((s) => s.hasLiquidity && s.priceCents != null),
      });
    }
    if (withinHoursAhead != null) {
      const now = this.serverNow();
      const lo = now - withinHoursBehind * 3600e3;
      const hi = now + withinHoursAhead * 3600e3;
      games = games.filter((g) => {
        if (!g.occurrenceTime) return true; // don't drop games with no scheduled time
        const t = Date.parse(g.occurrenceTime);
        return Number.isNaN(t) || (t >= lo && t <= hi);
      });
    }
    // Soonest games first.
    games.sort((a, b) => (Date.parse(a.occurrenceTime || 0) || 0) - (Date.parse(b.occurrenceTime || 0) || 0));
    return games;
  }

  #cache(market) {
    const { ticker, priceCents } = normalizeMarket(market);
    if (ticker && priceCents != null) this.prices.set(ticker, priceCents);
  }
}

export { NOT_CONFIGURED };
