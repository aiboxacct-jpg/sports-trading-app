// simEngine.js — the SIMULATION engine.
//
// Holds a simulated bankroll and a book of simulated positions, and produces
// snapshots (bankroll + target + positions) on demand. Everything here is
// hypothetical by construction: it uses a SimMarketProvider and stamps mode
// "SIMULATION" on every snapshot. Simulation history is kept entirely separate
// from any live record — this class never writes to a live store.

import { openPosition, valuePosition, settleValue } from '../domain/position.js';
import { computeBankroll } from '../domain/bankroll.js';
import { evaluateTarget, DEFAULT_TARGET_CENTS } from '../domain/target.js';
import { SimMarketProvider } from '../data/simMarketProvider.js';
import { rankBoard } from '../ranking/actionRanking.js';

export class SimEngine {
  constructor({ startingBankrollCents, targetCents = DEFAULT_TARGET_CENTS, feeRate, market } = {}) {
    if (startingBankrollCents == null) {
      throw new Error('SimEngine needs startingBankrollCents — the user sets the bankroll, it is never invented');
    }
    this.mode = 'SIMULATION';
    this.startingBankrollCents = startingBankrollCents;
    this.targetCents = targetCents;
    this.feeRate = feeRate;
    this.market = market ?? new SimMarketProvider();
    /** @type {import('../domain/position.js').Position[]} */
    this.positions = [];
    this._seq = 0;
  }

  /** Serialize the full engine state to a plain object (for persistence). */
  toState() {
    return {
      startingBankrollCents: this.startingBankrollCents,
      targetCents: this.targetCents,
      feeRate: this.feeRate ?? null,
      seq: this._seq,
      positions: this.positions,
      prices: this.market?.prices instanceof Map ? Object.fromEntries(this.market.prices) : {},
    };
  }

  /** Rebuild an engine from a persisted state object. */
  static fromState(s) {
    const eng = new SimEngine({
      startingBankrollCents: s.startingBankrollCents,
      targetCents: s.targetCents,
      feeRate: s.feeRate ?? undefined,
    });
    eng._seq = s.seq ?? 0;
    eng.positions = Array.isArray(s.positions) ? s.positions : [];
    for (const [ticker, cents] of Object.entries(s.prices ?? {})) {
      try { eng.market.setPrice(ticker, cents); } catch { /* skip invalid saved price */ }
    }
    return eng;
  }

  /** Set a hypothetical market price (cents). Chainable. */
  setPrice(ticker, priceCents) {
    this.market.setPrice(ticker, priceCents);
    return this;
  }

  /** Update the live game state for a position (inning/score/etc.). */
  setGameState(id, gameState) {
    this._require(id).currentGameState = gameState;
    return this;
  }

  /** Open a simulated position. Returns the created position. */
  open(spec) {
    const pos = openPosition({
      id: spec.id ?? `sim-${++this._seq}`,
      feeRate: this.feeRate,
      ...spec,
    });
    this.positions.push(pos);
    return pos;
  }

  _require(id) {
    const p = this.positions.find((x) => x.id === id);
    if (!p) throw new Error(`No position with id "${id}"`);
    return p;
  }

  /** Exit an open position at a given price — realizes pure profit (net of exit fee). */
  close(id, exitPriceCents, exitTs = new Date().toISOString()) {
    const p = this._require(id);
    if (p.status !== 'open') throw new Error(`Position "${id}" is ${p.status}, cannot close`);
    const v = valuePosition(p, exitPriceCents);
    p.status = 'closed';
    p.exitPriceCents = exitPriceCents;
    p.exitTs = exitTs;
    p.exitFeeCents = v.exitFeeCents;
    p.realizedPureProfitCents = v.unrealizedPureProfitCents;
    return p;
  }

  /** Settle an open position at expiry: outcome 'win' or 'loss'. No settlement fee. */
  settle(id, outcome, exitTs = new Date().toISOString()) {
    const p = this._require(id);
    if (p.status !== 'open') throw new Error(`Position "${id}" is ${p.status}, cannot settle`);
    const r = settleValue(p, outcome);
    p.status = 'settled';
    p.settlement = outcome;
    p.exitTs = exitTs;
    p.exitFeeCents = 0;
    p.realizedPureProfitCents = r.realizedPureProfitCents;
    return p;
  }

  /**
   * Rank a board of candidate markets using this engine's target/fee settings.
   * Candidates may carry an explicit `priceCents`, or a `ticker` resolved from the
   * engine's market provider. Combo legs resolve the same way. Pure simulation.
   */
  rankBoard(board, { stakeCents, weights, historical } = {}) {
    if (stakeCents == null) throw new Error('rankBoard needs a stakeCents to size positions');
    const resolve = (item) => {
      if ((item.kind ?? 'single') === 'combo') {
        return {
          ...item,
          legs: (item.legs ?? []).map((l) => ({
            ...l,
            priceCents: l.priceCents ?? (l.ticker ? this.market.getPrice(l.ticker) : null),
          })),
        };
      }
      return {
        ...item,
        priceCents: item.priceCents ?? (item.ticker ? this.market.getPrice(item.ticker) : null),
      };
    };
    return rankBoard(board.map(resolve), {
      stakeCents,
      targetCents: this.targetCents,
      feeRate: this.feeRate,
      weights,
      historical,
    });
  }

  /** Full computed snapshot: bankroll + target + per-position valuation. */
  snapshot(now = new Date().toISOString()) {
    const priceOf = (pos) => this.market.getPrice(pos.ticker);

    const bankroll = computeBankroll({
      startingBankrollCents: this.startingBankrollCents,
      positions: this.positions,
      priceOf,
    });

    const target = evaluateTarget({
      targetCents: this.targetCents,
      realizedPureProfitCents: bankroll.realizedPureProfitCents,
      unrealizedIfExitNowCents: bankroll.unrealizedPureProfitCents,
      guaranteedWorstCaseCents: bankroll.guaranteedWorstCaseCents,
    });

    const positions = this.positions.map((p) => {
      const currentPriceCents = p.status === 'open' ? priceOf(p) : p.exitPriceCents;
      let mark = null;
      if (p.status === 'open' && currentPriceCents != null) {
        mark = valuePosition(p, currentPriceCents);
      }
      return {
        ...p,
        currentPriceCents,
        currentValueCents: mark ? mark.positionValueCents : null,
        unrealizedPureProfitCents: mark ? mark.unrealizedPureProfitCents : null,
        priced: p.status !== 'open' || currentPriceCents != null,
      };
    });

    return {
      mode: this.mode,
      source: this.market.source,
      verified: this.market.verified,
      generatedAt: now,
      bankroll,
      target,
      positions,
    };
  }
}
