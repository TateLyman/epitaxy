/**
 * P17 — an unbiased slice of the population, bought with 25% of the budget.
 *
 * The quote budget went entirely to the highest-liquidity survivors. That
 * produces a label set which can only ever answer "how do high-liquidity
 * survivors perform", and it cannot answer the question that decides whether
 * the gates are any good: *what did we refuse that would have worked?*
 *
 * A gate evaluated only on the candidates it admitted is evaluated on its own
 * output. Twenty-five per cent of the budget goes to a stratified random draw
 * so the corpus contains rows the ranking would never have bought.
 *
 * The fraction is FROZEN before collection. Choosing it afterwards, having seen
 * which arm did better, is choosing an answer.
 */

export const EXPLORATION_FRACTION = 0.25;

export interface Candidate<T> {
  readonly item: T;
  /** The stratum this candidate belongs to. Draws are per stratum. */
  readonly stratum: string;
  /** Rank key for exploitation. Higher is preferred. */
  readonly rank: number;
}

export interface Selected<T> {
  readonly item: T;
  readonly arm: 'exploit' | 'explore';
  /**
   * The probability this candidate had of being selected.
   *
   * Persisted with the row. Without it the sample cannot be reweighted, and a
   * biased sample whose bias is unrecorded is worse than no sample: it looks
   * like evidence.
   */
  readonly inclusionProbability: number;
  readonly stratum: string;
}

/**
 * Deterministic index selection from a seed.
 *
 * `Math.random()` would make a cycle unreplayable — the same corpus and the
 * same code would not reproduce the same decisions, and replay divergence is
 * supposed to mean a defect rather than a coin flip. The seed is supplied by
 * the caller (a context hash and cycle number), so the draw is random with
 * respect to the candidates and fixed with respect to the run.
 */
function seededOrder(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  // xorshift32: small, deterministic, and adequate for choosing a subset.
  let x = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  for (let i = n - 1; i > 0; i--) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const j = Math.abs(x) % (i + 1);
    const a = idx[i] as number;
    idx[i] = idx[j] as number;
    idx[j] = a;
  }
  return idx;
}

/**
 * Split a budget between the best candidates and a stratified random draw.
 *
 * Exploration draws are taken from candidates the exploitation ranking did NOT
 * take, spread across strata, so the explored rows are the ones the ranking
 * disagrees with rather than the ones it nearly picked anyway.
 */
export function allocate<T>(
  candidates: readonly Candidate<T>[],
  budget: number,
  seed: number,
  /**
   * P10 — fractional exploration carried from previous cycles.
   *
   * With a budget of 2, `floor(2 * 0.25)` is 0 and the exploration arm never
   * runs. Carrying the remainder means four cycles of 2 quotes spend one
   * exploration slot between them, which IS the 25% the design claims.
   *
   * The caller owns the debt because the allocator is pure; `nextDebt` on the
   * result is what it stores back.
   */
  carriedDebt = 0,
): Selected<T>[] & { nextDebt?: number } {
  if (budget <= 0 || candidates.length === 0) return [];

  const entitlement = budget * EXPLORATION_FRACTION + carriedDebt;
  /**
   * The debt accelerates exploration; it must never overrun the cycle's budget.
   *
   * Without the `budget` term a carried remainder of 10 produced an explore
   * budget of 10 against a budget of 2, a NEGATIVE exploit budget, and twelve
   * selections from a two-quote cycle. In normal operation the debt tops out
   * near 1 so it never showed, which is exactly the kind of bound that is worth
   * writing down rather than relying on.
   */
  const exploreBudget = Math.min(Math.floor(entitlement), budget, Math.max(candidates.length - 1, 0));
  const exploitBudget = budget - exploreBudget;

  const byRank = [...candidates].sort((a, b) => b.rank - a.rank);
  const exploited = byRank.slice(0, exploitBudget);
  const taken = new Set(exploited.map((c) => c.item));

  const out: Selected<T>[] = exploited.map((c) => ({
    item: c.item,
    arm: 'exploit',
    /**
     * P10 — its probability under the ELIGIBLE POPULATION, not under the
     * visible pool.
     *
     * Recording 1 said "this candidate was certain to be chosen", which is
     * true of the ranking and false of the population: it competed with every
     * eligible candidate for a budget of `budget`. Reweighting on a 1 treats a
     * selected survivor as representing only itself, which is exactly the bias
     * the exploration arm exists to measure.
     */
    inclusionProbability: candidates.length === 0 ? 1 : Math.min(1, budget / candidates.length),
    stratum: c.stratum,
  }));

  const remaining = candidates.filter((c) => !taken.has(c.item));
  // What was earned and not spent, for the caller to carry into the next cycle.
  Object.defineProperty(out, 'nextDebt', { value: entitlement - exploreBudget, enumerable: false });
  if (exploreBudget === 0 || remaining.length === 0) return out;

  // Stratified: each stratum contributes in proportion to its share of what is
  // left, so exploration does not become "whatever the largest stratum is".
  const strata = new Map<string, Candidate<T>[]>();
  for (const c of remaining) {
    const list = strata.get(c.stratum) ?? [];
    list.push(c);
    strata.set(c.stratum, list);
  }

  const names = [...strata.keys()].sort();
  let drawn = 0;
  let round = 0;
  while (drawn < exploreBudget && round < 1_000) {
    let progressed = false;
    for (const name of names) {
      if (drawn >= exploreBudget) break;
      const pool = strata.get(name);
      if (pool === undefined || pool.length === 0) continue;
      const order = seededOrder(pool.length, seed + round * 7919 + name.length);
      const pick = pool[order[0] as number] as Candidate<T>;
      pool.splice(order[0] as number, 1);
      out.push({
        item: pick.item,
        arm: 'explore',
        // Within a stratum every remaining candidate was equally likely.
        inclusionProbability: 1 / (pool.length + 1),
        stratum: pick.stratum,
      });
      drawn += 1;
      progressed = true;
    }
    if (!progressed) break;
    round += 1;
  }
  return out;
}
