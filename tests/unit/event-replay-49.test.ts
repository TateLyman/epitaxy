import { describe, it, expect } from 'vitest';
import {
  classifyPoolEvent,
  orderEvents,
  replayPlan,
  planIsUsable,
  replayEvidenceClass,
  vaultDelta,
  type ObservedPoolEvent,
  type ReplayWindow,
} from '../../packages/pipeline/src/event-replay.js';

/**
 * Directive item 49 — `FULL_EVENT_REPLAY_TRAJECTORY`.
 *
 * The whole point of this module is that a replay with a hole in it is worse
 * than no replay: it is a pool at the wrong reserves for every event after the
 * hole, presented as the exact reference the bounded class is calibrated
 * against. So most of these tests are about what it REFUSES.
 */

const ev = (o: Partial<ObservedPoolEvent> & { signature: string; slot: number }): ObservedPoolEvent => ({
  orderInSlot: 0,
  baseVaultDeltaAtoms: 0n,
  quoteVaultDeltaLamports: 0n,
  ...o,
});

const window_ = (o: Partial<ReplayWindow> = {}): ReplayWindow => ({
  entrySlot: 100,
  exitSlot: 200,
  listedFromSlot: 90,
  listedToSlot: 210,
  truncated: false,
  ...o,
});

describe('49 — an event is what it DID to the vaults', () => {
  it('reads direction off the signs, not off an instruction discriminator', () => {
    // Quote in, base out: somebody bought. A router, an aggregator, or an AMM
    // instruction version we have never decoded all land the same way.
    expect(classifyPoolEvent(ev({ signature: 'a', slot: 1, quoteVaultDeltaLamports: 5n, baseVaultDeltaAtoms: -9n }))).toBe('BUY');
    expect(classifyPoolEvent(ev({ signature: 'b', slot: 1, quoteVaultDeltaLamports: -5n, baseVaultDeltaAtoms: 9n }))).toBe('SELL');
  });

  it('calls both-vaults-up a DEPOSIT, because a swap pays one out of the other', () => {
    expect(classifyPoolEvent(ev({ signature: 'c', slot: 1, quoteVaultDeltaLamports: 5n, baseVaultDeltaAtoms: 9n }))).toBe('DEPOSIT');
    expect(classifyPoolEvent(ev({ signature: 'd', slot: 1, quoteVaultDeltaLamports: -5n, baseVaultDeltaAtoms: -9n }))).toBe('WITHDRAW');
  });

  it('grades a MISSING delta as unknown, never as zero', () => {
    // Zero would classify a trade we failed to observe as a transaction that
    // did not trade — the pool would then be short that trade's reserves for
    // everything after it, silently.
    expect(classifyPoolEvent(ev({ signature: 'e', slot: 1, quoteVaultDeltaLamports: null, baseVaultDeltaAtoms: -9n }))).toBe('INDETERMINATE');
    expect(classifyPoolEvent(ev({ signature: 'f', slot: 1, baseVaultDeltaAtoms: null }))).toBe('INDETERMINATE');
  });

  it('refuses a one-sided move rather than guessing which side it was', () => {
    expect(classifyPoolEvent(ev({ signature: 'g', slot: 1, quoteVaultDeltaLamports: 5n, baseVaultDeltaAtoms: 0n }))).toBe('INDETERMINATE');
  });

  it('separates "touched the pool" from "traded against it"', () => {
    expect(classifyPoolEvent(ev({ signature: 'h', slot: 1 }))).toBe('NO_POOL_EFFECT');
  });

  it('derives a delta only from two observed balances', () => {
    expect(vaultDelta(10n, 30n)).toBe(20n);
    expect(vaultDelta(null, 30n)).toBeNull();
    expect(vaultDelta(10n, null)).toBeNull();
  });
});

describe('49 — "in order" means intra-block order too', () => {
  it('orders by slot and then by position within the block', () => {
    const { ordered } = orderEvents([
      ev({ signature: 'c', slot: 5, orderInSlot: 1 }),
      ev({ signature: 'a', slot: 4, orderInSlot: 9 }),
      ev({ signature: 'b', slot: 5, orderInSlot: 0 }),
    ]);
    expect(ordered.map((e) => e.signature)).toEqual(['a', 'b', 'c']);
  });

  it('refuses two transactions claiming one position in one block', () => {
    // Two trades in one block against one pool compose differently in each
    // order, so an unresolvable tie makes "in order" meaningless.
    const { ambiguous } = orderEvents([
      ev({ signature: 'a', slot: 5, orderInSlot: 2 }),
      ev({ signature: 'b', slot: 5, orderInSlot: 2 }),
    ]);
    expect(ambiguous).toHaveLength(1);
  });

  it('does not call the SAME signature listed twice ambiguous', () => {
    const { ambiguous } = orderEvents([
      ev({ signature: 'a', slot: 5, orderInSlot: 2 }),
      ev({ signature: 'a', slot: 5, orderInSlot: 2 }),
    ]);
    expect(ambiguous).toEqual([]);
  });
});

describe('49 — the plan replays INPUTS, in the window', () => {
  it('carries the input side of each swap and drops nothing silently', () => {
    const plan = replayPlan({
      window: window_(),
      events: [
        ev({ signature: 'buy1', slot: 110, quoteVaultDeltaLamports: 1_000n, baseVaultDeltaAtoms: -50n }),
        ev({ signature: 'sell1', slot: 120, quoteVaultDeltaLamports: -400n, baseVaultDeltaAtoms: 30n }),
      ],
    });
    expect(plan.refusals).toEqual([]);
    // The INPUT, not the output. Mainnet's output came from mainnet's reserves;
    // forcing it would erase the displacement the replay is measuring.
    expect(plan.steps).toEqual([
      { signature: 'buy1', slot: 110, kind: 'BUY', inputAmount: 1_000n },
      { signature: 'sell1', slot: 120, kind: 'SELL', inputAmount: 30n },
    ]);
  });

  it('excludes events at or before the entry and after the exit', () => {
    const plan = replayPlan({
      window: window_(),
      events: [
        ev({ signature: 'before', slot: 95, quoteVaultDeltaLamports: 1n, baseVaultDeltaAtoms: -1n }),
        ev({ signature: 'atEntry', slot: 100, quoteVaultDeltaLamports: 1n, baseVaultDeltaAtoms: -1n }),
        ev({ signature: 'inside', slot: 150, quoteVaultDeltaLamports: 1n, baseVaultDeltaAtoms: -1n }),
        ev({ signature: 'atExit', slot: 200, quoteVaultDeltaLamports: 1n, baseVaultDeltaAtoms: -1n }),
        ev({ signature: 'after', slot: 205, quoteVaultDeltaLamports: 1n, baseVaultDeltaAtoms: -1n }),
      ],
    });
    // The entry slot's state is already in the local snapshot; the exit slot's
    // trades are part of the holding period.
    expect(plan.steps.map((s) => s.signature)).toEqual(['inside', 'atExit']);
  });

  it('counts an inert event instead of refusing it', () => {
    const plan = replayPlan({ window: window_(), events: [ev({ signature: 'x', slot: 150 })] });
    expect(plan.inert).toBe(1);
    expect(plan.steps).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });
});

describe('49 — REFUSE, never skip', () => {
  it('refuses a liquidity event, which no swap can reproduce', () => {
    const plan = replayPlan({
      window: window_(),
      events: [ev({ signature: 'dep', slot: 150, quoteVaultDeltaLamports: 10n, baseVaultDeltaAtoms: 10n })],
    });
    expect(plan.refusals.map((r) => r.code)).toEqual(['LIQUIDITY_EVENT_NOT_REPLAYABLE']);
    expect(planIsUsable(plan)).toBe(false);
  });

  it('refuses a listing that does not reach back to the entry', () => {
    // Trades between the entry and the listing's floor are missing, and how
    // many is exactly what cannot be known.
    const plan = replayPlan({ window: window_({ listedFromSlot: 150 }), events: [] });
    expect(plan.refusals.map((r) => r.code)).toContain('EVENT_LIST_INCOMPLETE');
  });

  it('does NOT refuse a listing whose newest slot is below the exit', () => {
    // Measured on the first live pool: the listing is queried newest-first with
    // no cursor, so a newest slot below the exit is the observation that
    // nothing traded in between. Refusing on it rejected a quiet pool — the one
    // case where the replay is trivially exact, with zero events.
    const plan = replayPlan({ window: window_({ listedToSlot: 180 }), events: [] });
    expect(plan.refusals).toEqual([]);
    expect(planIsUsable(plan)).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it('DOES refuse a completely empty listing', () => {
    // A pool vault was created by a transaction. A vault with no signatures at
    // all is a provider that answered without answering.
    const plan = replayPlan({ window: window_({ listedToSlot: null, listedFromSlot: null }), events: [] });
    expect(plan.refusals.map((r) => r.code)).toContain('EVENT_LIST_INCOMPLETE');
  });

  it('refuses a truncated listing even when it looks complete', () => {
    const plan = replayPlan({ window: window_({ truncated: true }), events: [] });
    expect(plan.refusals.map((r) => r.code)).toContain('EVENT_LIST_TRUNCATED');
  });

  it('refuses an unobserved delta rather than treating it as no trade', () => {
    const plan = replayPlan({
      window: window_(),
      events: [ev({ signature: 'q', slot: 150, quoteVaultDeltaLamports: null, baseVaultDeltaAtoms: 5n })],
    });
    expect(plan.refusals.map((r) => r.code)).toEqual(['EVENT_DELTA_UNOBSERVED']);
  });

  it('refuses an ambiguous order', () => {
    const plan = replayPlan({
      window: window_(),
      events: [
        ev({ signature: 'a', slot: 150, orderInSlot: 1, quoteVaultDeltaLamports: 1n, baseVaultDeltaAtoms: -1n }),
        ev({ signature: 'b', slot: 150, orderInSlot: 1, quoteVaultDeltaLamports: 1n, baseVaultDeltaAtoms: -1n }),
      ],
    });
    expect(plan.refusals.map((r) => r.code)).toContain('EVENT_ORDER_AMBIGUOUS');
  });

  it('keeps the events it COULD build, so the refusal is diagnosable', () => {
    // The plan is unusable, but seeing which single event killed it is the
    // difference between fixing the collector and guessing.
    const plan = replayPlan({
      window: window_(),
      events: [
        ev({ signature: 'ok', slot: 150, quoteVaultDeltaLamports: 5n, baseVaultDeltaAtoms: -5n }),
        ev({ signature: 'dep', slot: 160, quoteVaultDeltaLamports: 5n, baseVaultDeltaAtoms: 5n }),
      ],
    });
    expect(plan.steps.map((s) => s.signature)).toEqual(['ok']);
    expect(planIsUsable(plan)).toBe(false);
  });
});

describe('49 — a failed replay falls back WITH its reason attached', () => {
  it('earns the full-replay class only when nothing was refused', () => {
    const plan = replayPlan({
      window: window_(),
      events: [ev({ signature: 'a', slot: 150, quoteVaultDeltaLamports: 5n, baseVaultDeltaAtoms: -5n })],
    });
    expect(replayEvidenceClass(plan)).toEqual({ klass: 'FULL_EVENT_REPLAY_TRAJECTORY', refusedBecause: [] });
  });

  it('falls back to bounded, naming why — never silently', () => {
    // "We could not replay this" is the fact that decides whether the bounded
    // number may be believed, so it travels with the downgrade.
    const plan = replayPlan({ window: window_({ truncated: true }), events: [] });
    const c = replayEvidenceClass(plan);
    expect(c.klass).toBe('BOUNDED_COUNTERFACTUAL_TRAJECTORY');
    expect(c.refusedBecause).toContain('EVENT_LIST_TRUNCATED');
  });

  it('deduplicates the reasons without losing any of them', () => {
    const plan = replayPlan({
      window: window_(),
      events: [
        ev({ signature: 'd1', slot: 150, quoteVaultDeltaLamports: 5n, baseVaultDeltaAtoms: 5n }),
        ev({ signature: 'd2', slot: 160, quoteVaultDeltaLamports: 5n, baseVaultDeltaAtoms: 5n }),
        ev({ signature: 'u1', slot: 170, quoteVaultDeltaLamports: null }),
      ],
    });
    expect([...replayEvidenceClass(plan).refusedBecause].sort()).toEqual([
      'EVENT_DELTA_UNOBSERVED',
      'LIQUIDITY_EVENT_NOT_REPLAYABLE',
    ]);
  });
});
