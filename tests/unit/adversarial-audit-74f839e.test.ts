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
 * ADVERSARIAL AUDIT PROBES — head 74f839e.
 *
 * These tests are NOT assertions that the system is correct. They are
 * characterisation probes that pin down what the code ACTUALLY does at the
 * points the audit directive names, so a later repair has a failing baseline to
 * move. Where the observed behaviour contradicts the directive, the expectation
 * below encodes the OBSERVED behaviour and the comment names the contradiction.
 *
 * Per the directive: record first, do not repair inside the audit.
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
  it('prices the sell from PRE-BUY state and still reports quoteStateSurvived = true', async () => {
    // DIRECTIVE REQUIRES: "the sell quote reads the exact state immediately
    // before sell execution" and "the complete post-state is available".
    //
    // OBSERVED: when `observe` returns zero accounts, the overlay is empty, so
    // `postSrc` degrades silently to the PRE-BUY snapshot. The sell is priced
    // from a state that never contained the entry — the precise defect P3
    // exists to remove — and `assertQuoteStateSurvived` passes vacuously
    // because it iterates the (empty) quoted set.
    const seen: { poolBytes: string | null } = { poolBytes: null };
    const r = await sequentialRoundTrip(requestSeeingState(seen), blindObserveWorker());

    // The sell was priced from the pre-buy pool.
    expect(seen.poolBytes).toBe(PRE_BUY_POOL_BYTES);
    expect(seen.poolBytes).not.toBe(POST_BUY_POOL_BYTES);

    // And the round trip nevertheless certifies the state survived.
    expect(r.quoteStateSurvived).toBe(true);
    expect(r.failure).toBeNull();
    expect(r.ok).toBe(true);
  });

  it('does not surface the unobserved price-bearing account anywhere in the result', async () => {
    // DIRECTIVE REQUIRES: "every required writable is observed".
    // OBSERVED: `ObserveResult.unobserved` is returned by the worker and then
    // dropped. `RoundTripResult` carries only INIT-time incompleteness.
    const seen: { poolBytes: string | null } = { poolBytes: null };
    const r = await sequentialRoundTrip(requestSeeingState(seen), blindObserveWorker());
    expect(r.incompleteness).toEqual([]);
    // The quoted ObserveResult is carried, but its `unobserved` list — naming
    // the price-bearing account the runtime never read — is not acted on.
    expect(r.quoted?.unobserved).toEqual([POOL]);
    expect(r.quoted?.accounts).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('ignores a sell step that reports unobserved writables', async () => {
    // OBSERVED: per-step `unobserved` is never consulted; the trip is ok.
    const seen: { poolBytes: string | null } = { poolBytes: null };
    const r = await sequentialRoundTrip(requestSeeingState(seen), blindObserveWorker(['SomeWritable']));
    expect(r.ok).toBe(true);
    expect(r.incompleteness).toEqual([]);
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
  it('accepts a snapshot whose sysvars come from a DIFFERENT slot than its pool', async () => {
    // DIRECTIVE REQUIRES: forcing batches to different context slots must
    // either retry to one coherent slot or refuse. "It may not stamp one slot
    // over a mixed state."
    //
    // OBSERVED: drift is computed over economically-mutable accounts only, and
    // those are capped at ONE 100-account batch, so low === high always. The
    // Clock — which the replayed runtime's time comes from, and which drives
    // the time-windowed volume accumulator — is fetched in the STATIC batch and
    // is exempt. A 100-slot gap is accepted silently.
    const snap = await captureCoherentSnapshotV2(
      splitSlotReader({ economicSlot: 1_000, staticSlot: 1_100 }),
      baseReq,
      b58,
    );
    expect(snap.economicDriftSlots).toBe(0);
    expect(snap.driftBoundSlots).toBe(0);
    expect(snap.captureSlotHigh).toBe(1_000);
    // The mixed state is visible in batchSlots but is not enforced against.
    expect(snap.batchSlots).toEqual([1_000, 1_100]);
    // The clock the runtime will be built from is 100 slots ahead of the pool.
    expect(snap.clock?.slot).toBe('1100');
  });

  it('economic drift is structurally zero because one batch carries one slot', async () => {
    // Every economic account is served by a single getMultipleAccounts call, so
    // they all inherit that call's context slot. `high - low` is therefore 0 by
    // construction and the refusal branch is unreachable in production.
    for (const [econ, stat] of [
      [500, 500],
      [500, 900],
      [500, 100_000],
    ]) {
      const snap = await captureCoherentSnapshotV2(
        splitSlotReader({ economicSlot: econ as number, staticSlot: stat as number }),
        baseReq,
        b58,
      );
      expect(snap.economicDriftSlots).toBe(0);
    }
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
  it('a MISSING Clock sysvar yields a successful snapshot with clock = null', async () => {
    // DIRECTIVE REQUIRES: removing Clock "must produce a named refusal, never a
    // default". OBSERVED: the capture succeeds and the caller must notice a
    // null field and a string in `incompleteness`.
    const snap = await captureCoherentSnapshotV2(
      splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [CLOCK_SYSVAR] }),
      baseReq,
      b58,
    );
    expect(snap.clock).toBeNull();
    expect(snap.incompleteness).toContain('the Clock sysvar was not captured');
    expect(snap.snapshotHash).toBeTruthy(); // it still produced a usable snapshot
  });

  it('a MISSING Rent sysvar likewise succeeds', async () => {
    const snap = await captureCoherentSnapshotV2(
      splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [RENT_SYSVAR] }),
      baseReq,
      b58,
    );
    expect(snap.rent).toBeNull();
    expect(snap.incompleteness).toContain('the Rent sysvar was not captured');
  });

  it('a MISSING fee config explicitly falls back to the program default', async () => {
    // This is the directive's named failure mode in the code's own words.
    const snap = await captureCoherentSnapshotV2(
      splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [FEE_CONFIG] }),
      { ...baseReq, feeConfig: FEE_CONFIG },
      b58,
    );
    expect(snap.feeConfigHash).toBeNull();
    expect(snap.incompleteness).toContain('the fee config account is absent, so the tier is the program default');
  });

  it('a MISSING economic pool is only an omission unless it is named requireDecodable', async () => {
    const snap = await captureCoherentSnapshotV2(
      splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [ECON_POOL] }),
      baseReq,
      b58,
    );
    expect(snap.omissions).toContain(ECON_POOL);
    expect(snap.snapshotHash).toBeTruthy();

    // With requireDecodable it does refuse, by name.
    await expect(
      captureCoherentSnapshotV2(
        splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, omit: [ECON_POOL] }),
        { ...baseReq, requireDecodable: [ECON_POOL] },
        b58,
      ),
    ).rejects.toThrow(/is required to decode but is absent/);
  });
});

describe('AUDIT §3 — requireDecodable does not decode', () => {
  it('accepts a CORRUPT pool as long as it has a nonzero byte length', async () => {
    // DIRECTIVE REQUIRES: a corrupted pool must produce a named refusal.
    // OBSERVED: `requireDecodable` tests presence and `dataBase64.length !== 0`
    // only. Eleven bytes of garbage in the pool account passes the gate that is
    // documented as "an economic account that is present but undecodable
    // refuses the snapshot".
    const garbage = Buffer.from('not-a-pool!').toString('base64');
    const snap = await captureCoherentSnapshotV2(
      splitSlotReader({ economicSlot: 1_000, staticSlot: 1_000, poolBytes: garbage }),
      { ...baseReq, requireDecodable: [ECON_POOL] },
      b58,
    );
    expect(snap.snapshotHash).toBeTruthy();
    expect(snap.accounts.find((a) => a.pubkey === ECON_POOL)?.dataBase64).toBe(garbage);
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

  it('a null exit capacity is skipped rather than treated as deterioration', () => {
    const m = marks([1_000_000n, null, 500_000n]);
    const det = decideExit('FLOW_LIQUIDITY_DETERIORATION_V1', opened, m);
    // The 1,000,000 -> 500,000 comparison is never made because the
    // intervening mark is null; only ADJACENT pairs are compared.
    expect(det.triggeredAtMs).toBeNull();
  });
});
