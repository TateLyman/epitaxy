/**
 * `reject:panel-v2` — the frozen rule.
 *
 * This is the object that makes the panel prospective. It is a literal in
 * source, at a fixed commit, with a fixed declaration instant — so the horizons
 * and the metric are things that were decided BEFORE any row was admitted, and
 * a reader can check that rather than take it on trust.
 *
 * ## Why the declaration instant is hardcoded
 *
 * `Date.now()` at startup would re-declare the panel every run, and the check
 * that a rule was frozen before the rows it admits would pass vacuously —
 * always true, because the rule would always have just been declared. A literal
 * is the only version of this that can fail.
 *
 * Rows rejected BEFORE this instant are outside the panel and stay outside it.
 * The corpus already holds thousands of `reject_tracking` rows; back-admitting
 * them would be exactly the retrospective panel this command exists to replace.
 *
 * ## Changing any of this
 *
 * A different horizon set or a different metric is a NEW panel with a NEW id.
 * `declarePanel` refuses to redefine a frozen one. That refusal is the whole
 * mechanism: a horizon added after seeing outcomes is a horizon chosen on them,
 * and it would not be visible in a diff of a config file nobody re-reads.
 */
export const REJECT_PANEL_V1 = {
  panelId: 'REJECT_PANEL_V1',
  /**
   * 2026-08-16T00:00:00Z, the day the rule was frozen.
   *
   * Deliberately the start of the day rather than the exact commit minute: the
   * screening path admits rows continuously, and a minute-precise boundary
   * would silently exclude whatever ran while this was being written.
   */
  declaredUtcMs: Date.UTC(2026, 7, 16, 0, 0, 0),
  /**
   * The same offsets the trajectory mark path uses.
   *
   * Shared on purpose: a rejected token and an opened one must be observed on
   * the same schedule, or the comparison between them is a comparison of two
   * measurement regimes.
   */
  horizonsMs: [60_000, 300_000, 900_000, 1_800_000, 3_600_000] as const,
  /**
   * What is scored.
   *
   * The executable quote for the standard development notional against the
   * pool's own reserves — NOT a router quote and NOT a USD price. 93% of a
   * previous corpus had no route at all, and a price that cannot be executed
   * cannot answer what a filter cost.
   */
  metric: 'EXECUTABLE_QUOTE_LAMPORTS_AT_DEVELOPMENT_NOTIONAL',
  notes:
    'Frozen before collection. Rows rejected before declaredUtcMs are outside this panel and are ' +
    'not back-admitted: the existing reject_tracking corpus was scored retrospectively and cannot ' +
    'be made prospective after the fact.',
} as const;

/** Whether a rejection instant falls inside the frozen panel. */
export function withinPanel(rejectedUtcMs: number): boolean {
  return rejectedUtcMs >= REJECT_PANEL_V1.declaredUtcMs;
}
