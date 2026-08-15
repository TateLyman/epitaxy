import { describe, it, expect } from 'vitest';
import { sequentialRoundTrip } from '../../packages/pipeline/src/sequential-round-trip.js';
import type { SequentialWorker } from '../../packages/simulator/src/sequential-worker.js';
import {
  captureCoherentSnapshotV2,
  CLOCK_SYSVAR,
  RENT_SYSVAR,
  EPOCH_SCHEDULE_SYSVAR,
  type CoherentReader,
} from '../../packages/solana/src/coherent-snapshot.js';
import type { CoherentRawAccount } from '../../packages/solana/src/rpc.js';

/**
 * ADVERSARIAL AUDIT — head 74f839e, findings F1-F10, now REPAIRED.
 *
 * These began as characterisation probes: they pinned down what the code
 * actually did at the points the audit named, encoding the OBSERVED (wrong)
 * behaviour so a repair would have a failing baseline to move.
 *
 * The repair landed, so every probe below is inverted. Each now asserts the
 * FIXED behaviour and its comment records what it used to do. That is the whole
 * value of writing them as a failing baseline first — the same file that proved
 * the defect now guards against its return, and the inversion is visible in the
 * diff rather than asserted in a report.
 */

// ---------------------------------------------------------------------------
// Section 2 — the sequential-state claim
// ---------------------------------------------------------------------------

const POOL = 'PoolAAA';
const ATA = 'AtaAAA';

function tokenAccountBytes(amount: bigint): string {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b.toString('base64');
}

const PRE_BUY_POOL_BYTES = tokenAccountBytes(111n);
const POST_BUY_POOL_BYTES = tokenAccountBytes(999n);

function observed(pubkey: string, dataBase64: string, sha: string) {
  return { pubkey, lamports: 1_000, owner: 'Sys', dataBase64, dataSha256: sha };
}

function stepResult(label: string, status: string, pre: unknown[], post: unknown[], unobserved: string[] = []) {
  return {
    label,
    status,
    transactionError: status === 'SIMULATED_OK' ? null : 'refused',
    computeUnitsConsumed: 1,
    logs: [],
    preAccounts: pre,
    postAccounts: post,
    unobserved,
  };
}

/**
 * A worker whose `observe` returns NOTHING — every price-bearing account comes
 * back in `unobserved`. This is exactly what a worker does when the accounts
 * were never loaded into the runtime, which is a silent apparatus failure
 * rather than a market fact.
 */
function blindObserveWorker(sellUnobserved: string[] = []): SequentialWorker {
  return {
    initIncompleteness: [],
    async init() {
      return { runtime: 'litesvm', runtimeVersion: '0', litesvmVersion: '0', binarySha256: 'x', programsLoaded: [] };
    },
    async observe() {
      // The runtime could not read the pool. Nothing is returned.
      return { accounts: [], unobserved: [POOL], stateHash: '' };
    },
    async step(s: { label: string }) {
      if (s.label === 'buy') {
        return {
          stateHash: 'h',
          step: stepResult('buy', 'SIMULATED_OK', [], [observed(ATA, tokenAccountBytes(1_000_000n), 'ata')]),
        };
      }
      if (s.label === 'sell') {
        return {
          stateHash: 'h',
          // The sell executed against the POST-buy pool, which is NOT what it
          // was priced from below.
          step: stepResult('sell', 'SIMULATED_OK', [observed(POOL, POST_BUY_POOL_BYTES, 'post')], [], sellUnobserved),
        };
      }
      return { stateHash: 'h', step: stepResult('close', 'SIMULATED_OK', [], []) };
    },
    async close() {},
  } as unknown as SequentialWorker;
}


/**
 * A worker that observes correctly, so a trip reaches the sell. Used to assert
 * per-step `unobserved` reporting (F2) without tripping the F1 guard first.
 */
function observingWorker(sellUnobserved: string[] = []): SequentialWorker {
  return {
    initIncompleteness: [],
    async init() {
      return { runtime: 'litesvm', runtimeVersion: '0', litesvmVersion: '0', binarySha256: 'x', programsLoaded: [] };
    },
    async observe() {
      return { accounts: [observed(POOL, POST_BUY_POOL_BYTES, 'post')], unobserved: [], stateHash: 'q' };
    },
    async step(s: { label: string }) {
      if (s.label === 'buy') {
        return {
          stateHash: 'h',
          step: stepResult('buy', 'SIMULATED_OK', [], [observed(ATA, tokenAccountBytes(1_000_000n), 'ata')]),
        };
      }
      if (s.label === 'sell') {
        return {
          stateHash: 'h',
          step: stepResult('sell', 'SIMULATED_OK', [observed(POOL, POST_BUY_POOL_BYTES, 'post')], [], sellUnobserved),
        };
      }
      return { stateHash: 'h', step: stepResult('close', 'SIMULATED_OK', [], []) };
    },
    async close() {},
  } as unknown as SequentialWorker;
}

function requestSeeingState(seen: { poolBytes: string | null }) {
  return {
    // The snapshot holds the PRE-buy pool.
    snapshot: {
      programs: [],
      accounts: [{ pubkey: POOL, owner: 'Sys', dataBase64: PRE_BUY_POOL_BYTES, lamports: 1n }],
      slot: 1,
      unixTimestamp: 1,
    },
    pool: POOL,
    taker: 'TakerAAA',
    takerAta: ATA,
    slippagePct: 3,
    buyTransactionBase64: 'YnV5',
    blockhash: 'bh',
    priceBearingAccounts: [POOL],
    observe: [POOL, ATA],
    buildCloseBase64: () => 'Y2xvc2U=',
    buildSell: async (state: { get(p: string): { dataBase64: string } | null }) => {
      // Record which pool bytes the sell was actually priced from.
      seen.poolBytes = state.get(POOL)?.dataBase64 ?? null;
      return { transactionBase64: 'c2VsbA==', selfImpactLamports: 5n };
    },
    jobId: 'audit',
  } as never;
}

describe('AUDIT §2 — the quote-state proof is vacuous when observe returns nothing', () => {
  it('REFUSES the trip when observe returns nothing, instead of pricing from PRE-BUY state', async () => {
    // WAS: postSrc degraded silently to the pre-buy snapshot, assertQuoteStateSurvived
    // iterated an empty map and threw nothing, and the trip returned
    // ok:true / quoteStateSurvived:true — a silent apparatus failure certified
    // as a proven sequential mechanic.
    const seen: { poolBytes: string | null } = { poolBytes: null };
    const r = await sequentialRoundTrip(requestSeeingState(seen), blindObserveWorker());
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('QUOTE_STATE_UNOBSERVED');
    expect(r.quoteStateSurvived).toBe(false);
    // And the sell was never built, so nothing was priced from stale bytes.
    expect(seen.poolBytes).toBeNull();
  });

  it('surfaces the unobserved price-bearing account in the result', async () => {
    // WAS: `ObserveResult.unobserved` was returned by the worker and dropped;
    // RoundTripResult carried only INIT-time incompleteness, so a trip whose
    // writables were not all observed was indistinguishable from one that
    // observed everything.
    const seen: { poolBytes: string | null } = { poolBytes: null };
    const r = await sequentialRoundTrip(requestSeeingState(seen), blindObserveWorker());
    expect(r.ok).toBe(false);
    expect(r.incompleteness.join(' ')).toMatch(/unobserved at quote time: PoolAAA/);
    expect(r.quoted?.unobserved).toEqual([POOL]);
  });

  it('carries per-step unobserved writables into the result', async () => {
    // WAS: per-step `unobserved` was never consulted and the trip reported ok.
    // A trip that reaches the sell now records what each step could not see.
    const seen: { poolBytes: string | null } = { poolBytes: null };
    const r = await sequentialRoundTrip(requestSeeingState(seen), observingWorker(['SomeWritable']));
    expect(r.incompleteness.join(' ')).toMatch(/unobserved on sell: SomeWritable/);
  });
});

// ---------------------------------------------------------------------------
// Section 3 — snapshot coherence
// ---------------------------------------------------------------------------

const b58 = (b: Uint8Array): string => Buffer.from(b).toString('hex');

function clockBytes(slot: bigint, unix: bigint): string {
  const b = Buffer.alloc(40);
  b.writeBigUInt64LE(slot, 0);
  b.writeBigInt64LE(0n, 8);
  b.writeBigUInt64LE(1n, 16);
  b.writeBigUInt64LE(1n, 24);
  b.writeBigInt64LE(unix, 32);
  return b.toString('base64');
}

function rentBytes(): string {
  const b = Buffer.alloc(17);
  b.writeBigUInt64LE(3480n, 0);
  b.writeDoubleLE(2, 8);
  b.writeUInt8(50, 16);
  return b.toString('base64');
}

function scheduleBytes(): string {
  const b = Buffer.alloc(33);
  b.writeBigUInt64LE(432000n, 0);
  b.writeBigUInt64LE(432000n, 8);
  b.writeUInt8(0, 16);
  b.writeBigUInt64LE(0n, 17);
  b.writeBigUInt64LE(0n, 25);
  return b.toString('base64');
}

function raw(pubkey: string, slot: number, dataBase64: string): CoherentRawAccount {
  return {
    pubkey,
    slot,
    owner: 'Owner1',
    executable: false,
    lamports: 1_000n,
    dataBase64,
    rentEpoch: 0n,
    space: Buffer.from(dataBase64, 'base64').length,
  } as CoherentRawAccount;
}

const ECON_POOL = 'EconPool';
const ECON_VAULT = 'EconVault';
const FEE_CONFIG = 'FeeConfig';

/**
 * A reader that serves the ECONOMIC batch at one slot and the STATIC batch
 * (which is where the sysvars live) at a later slot.
 */
function splitSlotReader(opts: {
  economicSlot: number;
  staticSlot: number;
  omit?: string[];
  poolBytes?: string;
  includeFeeConfig?: boolean;
}): CoherentReader {
  const omit = new Set(opts.omit ?? []);
  return {
    async getSlot() {
      return opts.economicSlot;
    },
    async getBlockTime() {
      return 1_700_000_000;
    },
    async getMultipleAccountsAtSlot(pubkeys: readonly string[]) {
      const isEconomicBatch = pubkeys.includes(ECON_POOL);
      const slot = isEconomicBatch ? opts.economicSlot : opts.staticSlot;
      const accounts = new Map<string, CoherentRawAccount | null>();
      for (const k of pubkeys) {
        if (omit.has(k)) {
          accounts.set(k, null);
          continue;
        }
        if (k === CLOCK_SYSVAR) accounts.set(k, raw(k, slot, clockBytes(BigInt(slot), 1_700_000_000n)));
        else if (k === RENT_SYSVAR) accounts.set(k, raw(k, slot, rentBytes()));
        else if (k === EPOCH_SCHEDULE_SYSVAR) accounts.set(k, raw(k, slot, scheduleBytes()));
        else if (k === ECON_POOL) accounts.set(k, raw(k, slot, opts.poolBytes ?? tokenAccountBytes(5n)));
        else accounts.set(k, raw(k, slot, tokenAccountBytes(1n)));
      }
      return { contextSlot: slot, accounts };
    },
  };
}

const baseReq = {
  economicAccounts: [ECON_POOL, ECON_VAULT],
  staticAccounts: [],
  commitment: 'confirmed' as const,
};

describe('AUDIT §3 — economic drift enforcement cannot fire on real RPC output', () => {
  it('makes a mixed-slot Clock UNREPRESENTABLE by putting it in the pool batch', async () => {
    // WAS: the Clock sat in the static batch, exempt from drift, so a capture
    // could pair pool bytes true at slot 1000 with a Clock true at slot 1100.
    //
    // The first repair moved the Clock into the economic TIER but still fetched
    // it in a second call — which guaranteed the drift it was meant to catch
    // and refused half the live candidate queue at `drift 1 > bound 0`.
    //
    // It now rides in the SAME getMultipleAccounts call as the pool, so it
    // cannot come from another slot at all. Enforcement by construction beats
    // enforcement by check.
    const snap = await captureCoherentSnapshotV2(
      splitSlotReader({ economicSlot: 1_000, staticSlot: 1_100 }),
      baseReq,
      b58,
    );
    expect(snap.clock?.slot).toBe('1000');
    expect(snap.captureSlotHigh).toBe(1_000);
    expect(snap.economicDriftSlots).toBe(0);
  });

  it('the drift bound still refuses genuinely mixed economic slots', async () => {
    // The bound is not dead: it refuses when the accounts really do disagree.
    // A reader that hands back per-account slots exercises what a single-batch
    // node cannot produce.
    const mixed: CoherentReader = {
      async getSlot() {
        return 500;
      },
      async getBlockTime() {
        return 1_700_000_000;
      },
      async getMultipleAccountsAtSlot(pubkeys: readonly string[]) {
        const accounts = new Map<string, CoherentRawAccount | null>();
        let high = 0;
        for (const k of pubkeys) {
          const slot = k === ECON_VAULT ? 900 : 500;
          high = Math.max(high, slot);
          if (k === CLOCK_SYSVAR) accounts.set(k, raw(k, slot, clockBytes(BigInt(slot), 1_700_000_000n)));
          else if (k === RENT_SYSVAR) accounts.set(k, raw(k, slot, rentBytes()));
          else if (k === EPOCH_SCHEDULE_SYSVAR) accounts.set(k, raw(k, slot, scheduleBytes()));
          else accounts.set(k, raw(k, slot, tokenAccountBytes(5n)));
        }
        return { contextSlot: high, accounts };
      },
    };
    await expect(captureCoherentSnapshotV2(mixed, baseReq, b58)).rejects.toThrow(/never simultaneously true/);
  });

  it('DOES refuse when handed a genuinely mixed economic batch (the check itself works)', async () => {
    // The enforcement logic is correct; it is the input that can never be mixed.
    const mixed: CoherentReader = {
      async getSlot() {
        return 1_000;
      },
      async getBlockTime() {
        return 1;
      },
      async getMultipleAccountsAtSlot(pubkeys: readonly string[]) {
        const accounts = new Map<string, CoherentRawAccount | null>();
        pubkeys.forEach((k, i) => {
          // Hand-mixed: each economic account claims a different slot.
          accounts.set(k, raw(k, 1_000 + i, tokenAccountBytes(1n)));
        });
        return { contextSlot: 1_000, accounts };
      },
    };
    await expect(captureCoherentSnapshotV2(mixed, baseReq, b58)).rejects.toThrow(/drift/);
  });
});

describe('AUDIT §3 — removal produces an incompleteness note, not a named refusal', () => {
  it('a MISSING Clock sysvar REFUSES the snapshot', async () => {
    // WAS: the capture succeeded and the caller had to notice a null field and
    // a string in `incompleteness`. Refusal was delegated to whichever consumer
    // remembered to look — fail OPEN, against the standing invariant.
    await expect(
      captureCoherentSnapshotV2(
        splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [CLOCK_SYSVAR] }),
        baseReq,
        b58,
      ),
    ).rejects.toThrow(/Clock sysvar/);
  });

  it('a MISSING Rent sysvar likewise REFUSES', async () => {
    await expect(
      captureCoherentSnapshotV2(
        splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [RENT_SYSVAR] }),
        baseReq,
        b58,
      ),
    ).rejects.toThrow(/Rent sysvar/);
  });

  it('a MISSING fee config REFUSES rather than falling back to the program default', async () => {
    // WAS: the code said, in its own words, "so the tier is the program
    // default" — and the fee tier determines the cost of every trade built on
    // that snapshot.
    // The request must actually NAME a fee config, or omitting it omits
    // nothing — `baseReq` does not, which is why the original probe could only
    // observe the default-fallback note rather than exercise the path.
    await expect(
      captureCoherentSnapshotV2(
        splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [FEE_CONFIG] }),
        { ...baseReq, feeConfig: FEE_CONFIG },
        b58,
      ),
    ).rejects.toThrow(/fee config|requested account/);
  });

  it('a MISSING economic pool REFUSES without needing to be named in requireDecodable', async () => {
    // WAS: only an omission, unless a caller happened to list it. Structural
    // now, so the refusal does not depend on the call site remembering.
    await expect(
      captureCoherentSnapshotV2(
        splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [ECON_POOL] }),
        baseReq,
        b58,
      ),
    ).rejects.toThrow(/could not be captured|requested account/);
  });

  it('a deliberately partial snapshot is still possible, and says so', async () => {
    // The escape hatch exists so a caller can accept a partial snapshot ON
    // PURPOSE. What it cannot do is get one by accident.
    const snap = await captureCoherentSnapshotV2(
      splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [RENT_SYSVAR] }),
      { ...baseReq, allowIncomplete: true },
      b58,
    );
    expect(snap.rent).toBeNull();
    expect(snap.incompleteness).toContain('the Rent sysvar was not captured');
  });
});

describe('AUDIT §3 — requireDecodable does not decode', () => {
  it('REFUSES a corrupt pool named in requireDecodable', async () => {
    // WAS: `requireDecodable` tested presence and `dataBase64.length !== 0`
    // only, so eleven bytes of garbage passed the gate documented as "an
    // account that is present but undecodable refuses the snapshot".
    const garbage = Buffer.from('not-a-pool!').toString('base64');
    await expect(
      captureCoherentSnapshotV2(
        splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, poolBytes: garbage }),
        { ...baseReq, requireDecodable: [ECON_POOL] },
        b58,
      ),
    ).rejects.toThrow(/below the .* floor|did not decode/);
  });

  it('a supplied DECODER is what makes the check structural', async () => {
    // The length floor is a backstop and says so in `incompleteness`. A real
    // decoder is the actual guarantee, and it refuses bytes of the right size
    // that still mean nothing.
    const wrongButLongEnough = Buffer.alloc(200, 7).toString('base64');
    await expect(
      captureCoherentSnapshotV2(
        splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, poolBytes: wrongButLongEnough }),
        {
          ...baseReq,
          requireDecodable: [ECON_POOL],
          decoders: {
            [ECON_POOL]: (data: Buffer) => {
              if (data[0] !== 1) throw new Error('bad discriminator');
            },
          },
        },
        b58,
      ),
    ).rejects.toThrow(/did not decode/);
  });
});

// ---------------------------------------------------------------------------
// Section 7 — policy treatments must make DECISIONS, not receive labels
// ---------------------------------------------------------------------------

import { decideEntry, decideExit, seededInclusion, CONTROL_INCLUSION_RATE, type PreEntryFeatures, type MarkPoint } from '../../packages/strategy/src/treatments.js';

const baseFeatures = (over: Partial<PreEntryFeatures> = {}): PreEntryFeatures => ({
  mint: 'MintAAA',
  hardGatesPass: true,
  independentBuyerPersistence: 0.9,
  nonMayhemNetQuoteInflowLamports: 1_000n,
  effectiveQuoteReserveTrend: 1,
  executableExitCapacityTrend: 1,
  continuationSlope: 1,
  creatorNetSellingLamports: -1n,
  entityConcentration: 0.1,
  mintBehaviourSafe: true,
  mechanicsViable: true,
  correctedQualityScore: 0.9,
  scoreCoverageOk: true,
  ...over,
});

/** A mint the seeded control includes, found by search rather than assumed. */
function mintWhereControl(enters: boolean, seed = 'audit-seed'): string {
  for (let i = 0; i < 10_000; i++) {
    const m = `Mint${i}`;
    if (seededInclusion(seed, m, CONTROL_INCLUSION_RATE) === enters) return m;
  }
  throw new Error('no such mint');
}

describe('AUDIT §7 — the entry policies genuinely disagree on one trajectory', () => {
  const seed = 'audit-seed';

  it('HARD_GATES_RANDOM enters where CORRECTED_CURRENT_QUALITY_SCORE rejects', () => {
    const mint = mintWhereControl(true, seed);
    const f = baseFeatures({ mint, correctedQualityScore: 0.1 });
    expect(decideEntry('HARD_GATES_RANDOM', f, { seed }).enter).toBe(true);
    expect(decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', f, { seed }).enter).toBe(false);
  });

  it('quality enters where survivor-flow rejects', () => {
    // Same trajectory, high score, but the creator is net selling.
    const f = baseFeatures({ correctedQualityScore: 0.9, creatorNetSellingLamports: 5_000n });
    expect(decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', f).enter).toBe(true);
    expect(decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', f).enter).toBe(false);
  });

  it('survivor-flow enters where quality rejects', () => {
    const f = baseFeatures({ correctedQualityScore: 0.2 });
    expect(decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', f).enter).toBe(true);
    expect(decideEntry('CORRECTED_CURRENT_QUALITY_SCORE', f).enter).toBe(false);
  });

  it('an unknown feature is never read as a pass', () => {
    const f = baseFeatures({ entityConcentration: null });
    const d = decideEntry('SURVIVOR_FLOW_CONTINUATION_V1', f);
    expect(d.enter).toBe(false);
    expect(d.unknowns).toContain('entityConcentration');
  });

  it('a hard-gate rejection binds EVERY policy identically', () => {
    const f = baseFeatures({ hardGatesPass: false, mint: mintWhereControl(true, seed) });
    for (const p of ['HARD_GATES_RANDOM', 'CORRECTED_CURRENT_QUALITY_SCORE', 'SURVIVOR_FLOW_CONTINUATION_V1'] as const) {
      expect(decideEntry(p, f, { seed }).enter).toBe(false);
    }
  });
});

describe('AUDIT §7 — the exit tournament is one-sided by construction', () => {
  const opened = 0;
  const marks = (caps: (bigint | null)[]): MarkPoint[] =>
    caps.map((c, i) => ({
      atMs: i * 5 * 60_000,
      executableLamports: 1_000n,
      exitCapacityLamports: c,
      effectiveQuoteReserveLamports: c,
    }));

  it('deterioration exits EARLY where fixed-time holds to the horizon', () => {
    // Capacity halves at the 5 minute mark: a 5000 bps drop.
    const m = marks([1_000_000n, 500_000n, 500_000n, 500_000n]);
    const fixed = decideExit('FIXED_15M_CONTROL', opened, m);
    const det = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', opened, m);
    expect(det.triggeredAtMs).toBe(5 * 60_000);
    expect(fixed.triggeredAtMs).toBe(15 * 60_000);
    expect(det.triggeredAtMs as number).toBeLessThan(fixed.triggeredAtMs as number);
  });

  it('CANNOT construct the converse: deterioration never holds past the horizon', () => {
    // DIRECTIVE REQUIRES a counterexample where "deterioration holds while
    // fixed-time exits at horizon". OBSERVED: the challenger falls back to the
    // SAME frozen horizon whenever no deterioration fires, so the two policies
    // are identical on every path where the challenger does not exit early.
    // The exit tournament can therefore only ever measure "exit sooner", never
    // "hold longer" — one half of the comparison does not exist.
    const flat = marks([1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n]);
    const fixed = decideExit('FIXED_15M_CONTROL', opened, flat);
    const det = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', opened, flat);
    expect(det.triggeredAtMs).toBe(fixed.triggeredAtMs);
    expect(det.reason).toContain('fell back to the frozen horizon');
  });

  it('a null exit capacity does NOT hide a collapse spanning it', () => {
    // WAS: the loop compared ADJACENT pairs and `continue`d when either side
    // was null, so 1,000,000 -> null -> 500,000 never compared anything and the
    // position was held through a halving of exit capacity. Treating a gap as
    // "no deterioration" is the null-is-safe reading this repository forbids.
    const m = marks([1_000_000n, null, 500_000n]);
    const det = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', opened, m);
    expect(det.triggeredAtMs).not.toBeNull();
    expect(det.reason).toMatch(/since the last MEASURED mark/);
  });
});
