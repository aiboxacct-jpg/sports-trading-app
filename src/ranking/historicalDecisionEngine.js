// historicalDecisionEngine.js — learns "historical fit" from PAST decisions.
//
// It never invents statistics. Below a minimum sample size it reports
// "insufficient historical data" rather than a made-up score, exactly as the spec
// requires. In simulation mode it is fed simulated outcomes; a live engine would
// feed it live outcomes into a SEPARATE instance (the two histories never mix).

import { fmt } from '../domain/money.js';

/** Price buckets used to group comparable decisions. */
export function priceBucket(priceCents) {
  if (priceCents < 34) return 'low';      // longshots
  if (priceCents <= 66) return 'mid';     // toss-ups
  return 'high';                          // favorites
}

const BUCKET_LABEL = { low: 'low (<34¢)', mid: 'mid (34–66¢)', high: 'high (>66¢)' };

/**
 * @typedef {Object} Decision
 * @property {'single'|'combo'} kind
 * @property {number} entryPriceCents
 * @property {boolean} won
 * @property {number} realizedPureProfitCents
 */

export class HistoricalDecisionEngine {
  constructor(decisions = [], { minSample = 5 } = {}) {
    /** @type {Decision[]} */
    this.decisions = [...decisions];
    this.minSample = minSample;
  }

  record(decision) {
    this.decisions.push(decision);
    return this;
  }

  /** Build decisions from settled/closed positions (won = made positive pure profit). */
  static fromPositions(positions) {
    const decisions = positions
      .filter((p) => p.status === 'settled' || p.status === 'closed')
      .map((p) => ({
        kind: p.kind ?? 'single',
        entryPriceCents: p.entryPriceCents,
        won: p.realizedPureProfitCents > 0,
        realizedPureProfitCents: p.realizedPureProfitCents,
      }));
    return new HistoricalDecisionEngine(decisions);
  }

  /**
   * Single-vs-combo comparison from history, with a plain-English verdict to steer
   * the user toward whichever has actually performed better (by avg realized profit).
   */
  kindSummary() {
    const summarize = (kind) => {
      const rows = this.decisions.filter((d) => d.kind === kind);
      const n = rows.length;
      const wins = rows.filter((d) => d.won).length;
      const avgRealizedCents = n ? Math.round(rows.reduce((a, d) => a + d.realizedPureProfitCents, 0) / n) : 0;
      return { n, wins, winRate: n ? wins / n : null, avgRealizedCents };
    };
    const single = summarize('single');
    const combo = summarize('combo');

    let verdict;
    if (single.n < this.minSample && combo.n < this.minSample) {
      verdict = 'Not enough history yet to compare singles vs combos.';
    } else if (single.n < this.minSample) {
      verdict = 'Not enough single history to compare with combos yet.';
    } else if (combo.n < this.minSample) {
      verdict = 'Not enough combo history to compare with singles yet.';
    } else if (single.avgRealizedCents > combo.avgRealizedCents) {
      verdict = `Favor singles — avg ${fmt(single.avgRealizedCents)} vs combos ${fmt(combo.avgRealizedCents)}.`;
    } else if (combo.avgRealizedCents > single.avgRealizedCents) {
      verdict = `Favor combos — avg ${fmt(combo.avgRealizedCents)} vs singles ${fmt(single.avgRealizedCents)}.`;
    } else {
      verdict = 'Singles and combos have performed about the same.';
    }
    return { single, combo, verdict };
  }

  /**
   * Historical fit for a candidate, matched by kind + price bucket.
   * Returns { score: 0..1 | null, sampleSize, rationale }.
   * score is null (neutral) when there isn't enough matching history.
   */
  fitFor({ kind = 'single', priceCents }) {
    const bucket = priceBucket(priceCents);
    const matches = this.decisions.filter(
      (d) => d.kind === kind && priceBucket(d.entryPriceCents) === bucket,
    );
    const n = matches.length;
    if (n < this.minSample) {
      return {
        score: null,
        sampleSize: n,
        rationale:
          n === 0
            ? 'Insufficient historical data (no comparable past decisions)'
            : `Insufficient historical data (only ${n} comparable, need ${this.minSample})`,
      };
    }
    const wins = matches.filter((d) => d.won).length;
    const winRate = wins / n;
    const avgPP = Math.round(
      matches.reduce((a, d) => a + d.realizedPureProfitCents, 0) / n,
    );
    return {
      score: winRate,
      sampleSize: n,
      rationale: `Your ${kind} positions at ${BUCKET_LABEL[bucket]}: ${wins}/${n} won (${Math.round(
        winRate * 100,
      )}%), avg realized ${fmt(avgPP)}`,
    };
  }
}
