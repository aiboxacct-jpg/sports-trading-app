// target.js — the four-state target machine.
//
// The default target is +$5.00 PURE PROFIT (500 cents). The states are distinct and
// must never be confused (a winning team is NOT a realized target):
//
//   TARGET NOT REACHED  realized + best executable exit still < target
//   TARGET AVAILABLE    you COULD exit now for >= target, but haven't (unrealized)
//   TARGET LOCKED       worst-case outcome across the book is already >= target
//                       (e.g. a hedge), even though nothing is closed yet
//   TARGET REALIZED     you have actually banked >= target in realized pure profit

export const TARGET_STATES = {
  NOT_REACHED: 'TARGET NOT REACHED',
  AVAILABLE: 'TARGET AVAILABLE',
  LOCKED: 'TARGET LOCKED',
  REALIZED: 'TARGET REALIZED',
};

export const DEFAULT_TARGET_CENTS = 500;

export function evaluateTarget({
  targetCents = DEFAULT_TARGET_CENTS,
  realizedPureProfitCents,
  unrealizedIfExitNowCents,
  guaranteedWorstCaseCents,
}) {
  const realizableIfExitNowCents = realizedPureProfitCents + unrealizedIfExitNowCents;

  let state;
  if (realizedPureProfitCents >= targetCents) {
    state = TARGET_STATES.REALIZED;
  } else if (guaranteedWorstCaseCents >= targetCents) {
    state = TARGET_STATES.LOCKED;
  } else if (realizableIfExitNowCents >= targetCents) {
    state = TARGET_STATES.AVAILABLE;
  } else {
    state = TARGET_STATES.NOT_REACHED;
  }

  const alert =
    state === TARGET_STATES.REALIZED ? '🚨🎯 TARGET ACHIEVED'
    : state === TARGET_STATES.AVAILABLE ? '🚨🎯 TARGET AVAILABLE'
    : state === TARGET_STATES.LOCKED ? '🎯 TARGET LOCKED'
    : null;

  return {
    state,
    alert,
    targetCents,
    realizedPureProfitCents,
    realizableIfExitNowCents,
    guaranteedWorstCaseCents,
    // How far the best available exit is from the target (0 when reachable).
    shortfallCents: Math.max(0, targetCents - realizableIfExitNowCents),
    // Progress toward target from realized profit only (0..1, clamped).
    realizedProgress: targetCents > 0
      ? Math.max(0, Math.min(1, realizedPureProfitCents / targetCents))
      : 1,
  };
}
