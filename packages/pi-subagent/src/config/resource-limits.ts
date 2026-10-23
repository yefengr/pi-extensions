/**
 * resource-limits.ts — Pure merge helpers for layered runtime budgets.
 *
 * maxTurns and maxDurationSeconds may only tighten as they flow from global
 * settings through the agent profile to the tool call, so the effective value
 * is the minimum of every defined layer. wrapUpTurns instead follows fixed
 * precedence (invocation > profile > global) and is then clamped below the
 * effective turn budget.
 */

/** Smallest positive candidate; undefined when no candidate is a positive number. */
export function minPositive(...values: Array<number | undefined>): number | undefined {
  let min: number | undefined;
  for (const value of values) {
    if (value == null || !Number.isFinite(value) || value < 1) continue;
    if (min === undefined || value < min) min = value;
  }
  return min;
}

/** Clamp a wrap-up turn budget to the [0, maxTurns - 1] window. */
export function clampWrapUpTurns(wrapUpTurns: number, maxTurns: number): number {
  const ceiling = Math.max(0, Math.floor(maxTurns) - 1);
  const floor = Math.max(0, Math.floor(wrapUpTurns));
  return Math.min(floor, ceiling);
}
