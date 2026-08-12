import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertCoherent,
  legIsExecutable,
  legIsConfirmatory,
  netExpectedOutput,
  netMinimumOutput,
  totalEntryCost,
  netExitProceeds,
  routePlanHash,
  RouteHybrid,
  FAMILY_CONTRACTS,
  isProviderFailure,
  isTokenFact,
  OBSERVATION_FAILURES,
  type ExecutionObservation,
} from '../../packages/domain/src/execution.js';
import { instructionSetHash, evaluateBuildPolicy, buildPolicyLimits } from '../../packages/solana/src/buildpolicy.js';
import {
  evaluateComputeBudget,
  MAX_COMPUTE_UNITS,
  MIN_PLAUSIBLE_COMPUTE_UNITS,
} from '../../packages/solana/src/instructionpolicy.js';
import {
  classifyHolder,
  loadEntityRegistry,
  resetEntityRegistry,
  SYSTEM_PROGRAM_ID,
} from '../../packages/solana/src/entity-registry.js';
import { AppConfigSchema, assertCanaryNoLooserThanLive, ConfigError } from '../../packages/domain/src/config.js';
import { evaluateCheapGates } from '../../packages/intelligence/src/gates.js';
import { sizePosition, plannedLossFractionBps } from '../../packages/strategy/src/portfolio.js';
import type { PortfolioState } from '../../packages/strategy/src/portfolio.js';
import { classifyFetchFailure } from '../../packages/adapters/src/jupiter/client.js';
import { SourceFetchError } from '../../packages/adapters/src/http.js';
import { MANAGED_STATES } from '../../packages/storage/src/observation-repo.js';
import type { MintInformation } from '../../packages/adapters/src/jupiter/schemas.js';

/**
 * §P16 — the tests that fail against the defects this session repaired.
 *
 * Numbered to the directive's list. Where a check already existed under a
 * different name it is not duplicated here; those are noted in
 * docs/AUDIT_HEAD_3155EA.md.
 */

const TAKER = 'So11111111111111111111111111111111111111112';
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const UNIT_LIMIT_IX = {
  programId: COMPUTE_BUDGET,
  data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]).toString('base64'),
};

const paper = AppConfigSchema.parse(JSON.parse(readFileSync('config/paper.json', 'utf8')));
const canary = AppConfigSchema.parse(JSON.parse(readFileSync('config/canary.json', 'utf8')));
const live = AppConfigSchema.parse(JSON.parse(readFileSync('config/live.json', 'utf8')));

function obs(over: Partial<ExecutionObservation> = {}): ExecutionObservation {
  return {
    observationId: 'o1',
    family: 'BUILD_CUSTOM',
    mint: 'M',
    side: 'buy',
    inputMint: 'A',
    outputMint: 'B',
    requestedAmount: 20_000_000n,
    expectedOutput: 1_000_000n,
    minimumOutput: 970_000n,
    slippageBps: 300,
    platformFeeBps: null,
    platformFeeAmount: null,
    platformFeeMint: null,
    signatureFeeLamports: null,
    prioritizationFeeLamports: null,
    rentFeeLamports: null,
    broadcasterTipLamports: 0n,
    routePlanHash: 'rp',
    routeLabels: ['Raydium'],
    instructionSetHash: 'ish',
    instructionCount: 7,
    computeUnitLimit: 200_000,
    transactionBytes: 900,
    lastValidBlockHeight: 1,
    expireAt: null,
    contextSlot: 42,
    rawPayloadHash: 'raw',
    endpoint: '/swap/v2/build',
    requestId: null,
    instructionPolicy: 'PASS',
    transactionPolicy: 'PASS',
    simulation: 'SIMULATED_OK',
    policyDetail: null,
    simulationDetail: null,
    requestedUtcMs: 0,
    receivedUtcMs: 1,
    latencyMs: 1,
    contextHash: 'ctx',
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('1 — /order price plus /build instructions cannot form one observation', () => {
  it('two different observation ids cannot describe one leg', () => {
    expect(() => assertCoherent(obs(), obs({ observationId: 'o2' }))).toThrow(RouteHybrid);
  });

  it('two families cannot describe one leg', () => {
    expect(() => assertCoherent(obs(), obs({ family: 'ORDER_EXECUTE' }))).toThrow(RouteHybrid);
  });

  it('two route plans cannot describe one leg', () => {
    expect(() => assertCoherent(obs(), obs({ routePlanHash: 'other' }))).toThrow(RouteHybrid);
  });

  it('two context slots cannot describe one leg', () => {
    expect(() => assertCoherent(obs(), obs({ contextSlot: 43 }))).toThrow(RouteHybrid);
  });

  it('ORDER_EXECUTE is never PnL-eligible on its own', () => {
    expect(FAMILY_CONTRACTS.ORDER_EXECUTE.pnlEligible).toBe(false);
    expect(FAMILY_CONTRACTS.QUOTE_ONLY_BENCHMARK.pnlEligible).toBe(false);
    expect(FAMILY_CONTRACTS.DIRECT_VENUE.pnlEligible).toBe(false);
    expect(FAMILY_CONTRACTS.BUILD_CUSTOM.pnlEligible).toBe(true);
    expect(legIsExecutable(obs({ family: 'ORDER_EXECUTE' })).ok).toBe(false);
  });
});

describe('2 — a probe-size quote cannot price a different entry size', () => {
  it('an observation carries the amount it was taken at', () => {
    const o = obs({ requestedAmount: 50_000_000n });
    expect(() => assertCoherent(o, obs({ requestedAmount: 20_000_000n }))).toThrow(RouteHybrid);
  });

  it('the config demands an exact-size build in every capital-bearing mode', () => {
    expect(paper.requireExactSizeBuild).toBe(true);
    expect(canary.requireExactSizeBuild).toBe(true);
    expect(live.requireExactSizeBuild).toBe(true);
  });
});

describe('3 & 4 — fees are charged exactly once, and nothing small is omitted', () => {
  it('an included platform fee is NOT deducted a second time', () => {
    // ORDER_EXECUTE includes the fee in the returned amounts. The old engine
    // multiplied by (1 - feeBps) on top of that.
    const o = obs({ family: 'ORDER_EXECUTE', platformFeeBps: 50, expectedOutput: 1_000_000n });
    expect(netExpectedOutput(o)).toBe(1_000_000n);
  });

  it('a fee that is NOT included is deducted once', () => {
    const o = obs({ family: 'BUILD_CUSTOM', platformFeeBps: 50, expectedOutput: 1_000_000n });
    expect(netExpectedOutput(o)).toBe(995_000n);
    expect(netMinimumOutput(obs({ platformFeeBps: 50, minimumOutput: 1_000_000n }))).toBe(995_000n);
  });

  it('BUILD_CUSTOM with no fee fields deducts nothing, rather than inventing a rate', () => {
    expect(netExpectedOutput(obs({ platformFeeBps: null, platformFeeAmount: null }))).toBe(1_000_000n);
  });

  it('the entry signature fee cannot be omitted', () => {
    const withFee = totalEntryCost({
      inputLamports: 20_000_000n,
      signatureFeeLamports: 5_000n,
      priorityFeeLamports: 200_000n,
      broadcasterTipLamports: 0n,
      ataRentLamports: 2_039_280n,
      transferFeeLamports: 0n,
      platformFeeLamports: 0n,
      assumedFailedAttemptLamports: 205_000n,
    });
    expect(withFee).toBe(20_000_000n + 5_000n + 200_000n + 2_039_280n + 205_000n);
    // 5000 lamports against the 0.02 SOL canary cap is 2.5bps. Not negligible
    // when the question is whether a few hundred bps of edge exists.
    expect((5_000n * 10_000n) / 20_000_000n).toBe(2n);
  });

  it('every exit cost is subtracted and rent is added only when recovered', () => {
    const net = netExitProceeds({
      grossProceedsLamports: 1_000_000n,
      signatureFeeLamports: 5_000n,
      priorityFeeLamports: 200_000n,
      broadcasterTipLamports: 1_000n,
      transferFeeLamports: 0n,
      closeAccountFeeLamports: 5_000n,
      assumedFailedAttemptLamports: 205_000n,
      ataRentRecoveredLamports: 0n,
    });
    expect(net).toBe(1_000_000n - 5_000n - 200_000n - 1_000n - 5_000n - 205_000n);
  });

  it('the config carries a failed-attempt cost rather than assuming attempts are free', () => {
    expect(paper.assumedFailedAttemptLamports > 0n).toBe(true);
  });
});

describe('5, 6 & 7 — the instruction-set hash is an identity', () => {
  const base = [
    UNIT_LIMIT_IX,
    { programId: JUPITER_V6, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }], data: 'AQ==' },
  ];

  it('changes when isSigner changes', () => {
    const flipped = [
      UNIT_LIMIT_IX,
      { programId: JUPITER_V6, accounts: [{ pubkey: TAKER, isSigner: false, isWritable: true }], data: 'AQ==' },
    ];
    expect(instructionSetHash(base)).not.toBe(instructionSetHash(flipped));
  });

  it('changes when isWritable changes', () => {
    const flipped = [
      UNIT_LIMIT_IX,
      { programId: JUPITER_V6, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: false }], data: 'AQ==' },
    ];
    expect(instructionSetHash(base)).not.toBe(instructionSetHash(flipped));
  });

  it('changes when the instruction ORDER changes', () => {
    expect(instructionSetHash(base)).not.toBe(instructionSetHash([...base].reverse()));
  });

  it('changes when a lookup table resolves to different addresses', () => {
    const a = instructionSetHash(base, { T1: ['A', 'B'] });
    const b = instructionSetHash(base, { T1: ['A', 'C'] });
    expect(a).not.toBe(b);
  });

  it('is stable for an identical set', () => {
    expect(instructionSetHash(base, { T1: ['A'] })).toBe(instructionSetHash(base, { T1: ['A'] }));
  });

  it('a route plan hash distinguishes a different split', () => {
    expect(routePlanHash([{ ammKey: 'k', percent: 100 }])).not.toBe(
      routePlanHash([
        { ammKey: 'k', percent: 50 },
        { ammKey: 'j', percent: 50 },
      ]),
    );
  });
});

describe('8 — a provider failure stays a provider failure', () => {
  it('a 429 is not a token fact', () => {
    const f = classifyFetchFailure(new SourceFetchError('rate_limited', 'jup', 'slow down', 429, true));
    expect(f).toBe('HTTP_429');
    expect(isProviderFailure(f)).toBe(true);
    expect(isTokenFact(f)).toBe(false);
  });

  it('a 404 IS a token fact', () => {
    const f = classifyFetchFailure(new SourceFetchError('not_found', 'jup', 'no route', 404, false));
    expect(f).toBe('NO_ROUTE');
    expect(isTokenFact(f)).toBe(true);
    expect(isProviderFailure(f)).toBe(false);
  });

  it('every failure kind maps somewhere, and none maps to silence', () => {
    const kinds = ['rate_limited', 'server_error', 'timeout', 'schema_drift', 'not_json', 'auth'] as const;
    for (const k of kinds) {
      const f = classifyFetchFailure(new SourceFetchError(k, 'jup', 'x', 500, false));
      expect(OBSERVATION_FAILURES).toContain(f);
    }
  });
});

describe('9 & 10 — a blocked exit stays managed and releases nothing', () => {
  it('EXIT_BLOCKED is in the managed set', () => {
    expect(MANAGED_STATES).toContain('EXIT_BLOCKED');
    expect(MANAGED_STATES).toContain('POSITION_OPEN');
    expect(MANAGED_STATES).toContain('EXIT_INTENT');
    expect(MANAGED_STATES).toContain('RECONCILING');
  });

  it('an exit observation that is not executable cannot back a close', () => {
    expect(legIsExecutable(obs({ side: 'sell', instructionSetHash: null })).ok).toBe(false);
    expect(legIsExecutable(obs({ side: 'sell', transactionPolicy: 'FAIL' })).ok).toBe(false);
    expect(legIsExecutable(obs({ side: 'sell', simulation: 'NOT_SIMULATED' })).ok).toBe(false);
  });

  it('22 — requireLocalSimulation is READ, not ceremonial config', () => {
    const unsimulated = obs({ simulation: 'NOT_SIMULATED' });
    // The flag has to change the answer, or it is a field nothing consults --
    // which is the defect class this repository keeps rediscovering.
    expect(legIsExecutable(unsimulated, { requireLocalSimulation: true }).ok).toBe(false);
    expect(legIsExecutable(unsimulated, { requireLocalSimulation: false }).ok).toBe(true);
    // And the paper config sets it, so the engine refuses today.
    expect(paper.requireLocalSimulation).toBe(true);
  });

  it('a row is never CONFIRMATORY without simulation, whatever the config says', () => {
    // legIsExecutable decides whether the engine may act. legIsConfirmatory
    // decides whether the row is evidence. An operator may collect development
    // data without a simulator; nobody may call it confirmatory.
    expect(legIsConfirmatory(obs({ simulation: 'NOT_SIMULATED' })).ok).toBe(false);
    expect(legIsConfirmatory(obs()).ok).toBe(true);
  });
});

describe('16 & 17 — risk sizing and mode ordering', () => {
  it('the catastrophic floor bounds size, and the stop cannot loosen it', () => {
    expect(plannedLossFractionBps(paper, null)).toBe(10_000);
    expect(plannedLossFractionBps(paper, 500)).toBe(10_000);
    const noFloor = { ...paper, catastrophicLossFloorPct: 0 };
    expect(plannedLossFractionBps(noFloor, null)).toBe(paper.exits.stopLossBps);
    expect(plannedLossFractionBps(noFloor, 9_000)).toBe(9_000);
  });

  it('aggregate planned loss includes the proposed trade', () => {
    const nav = 200n * 1_000_000_000n;
    const cap = (nav * BigInt(Math.round(paper.risk.maxAggregatePlannedLossPct * 100))) / 10_000n;
    const state: PortfolioState = {
      navLamports: nav,
      freeLamports: nav,
      openPositions: 0,
      totalExposureLamports: 0n,
      realizedTodayLamports: 0n,
      realizedWeekLamports: 0n,
      plannedLossLamports: cap - 1n,
      peakNavLamports: nav,
      observedSevereLossBps: null,
    };
    // The existing book alone is under the cap by one lamport. The proposed
    // trade pushes it over, and the old check would have allowed it.
    expect(sizePosition(state, paper, 1).refusal).toBe('aggregate_planned_loss');
  });

  it('canary is no looser than live in any dimension', () => {
    expect(() => assertCanaryNoLooserThanLive(canary.risk, live.risk)).not.toThrow();
  });

  it('a canary that IS looser is refused', () => {
    const looser = { ...canary.risk, riskBudgetPctPerTrade: live.risk.riskBudgetPctPerTrade * 2 };
    expect(() => assertCanaryNoLooserThanLive(looser, live.risk)).toThrow(ConfigError);
    const lowerReserve = { ...canary.risk, minSolReserveLamports: live.risk.minSolReserveLamports - 1n };
    expect(() => assertCanaryNoLooserThanLive(lowerReserve, live.risk)).toThrow(ConfigError);
  });
});

describe('18 — an unknown holder owner is not verified-safe inventory', () => {
  const registry = loadEntityRegistry();

  it('a System-Program-owned account is a wallet', () => {
    const c = classifyHolder({ owner: 'W', ownerProgram: SYSTEM_PROGRAM_ID }, registry);
    expect(c.holderClass).toBe('WALLET');
    expect(c.excludedFromWalletConcentration).toBe(false);
  });

  it('an UNRESOLVED owner counts as wallet concentration, not as pool inventory', () => {
    const c = classifyHolder({ owner: null, ownerProgram: null }, registry);
    expect(c.holderClass).toBe('UNKNOWN');
    expect(c.excludedFromWalletConcentration).toBe(false);
  });

  it('a verified market program IS excluded', () => {
    const pumpswap = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
    const c = classifyHolder({ owner: 'P', ownerProgram: pumpswap }, registry);
    expect(c.holderClass).toBe('VERIFIED_PROGRAM_CONTROLLED');
    expect(c.excludedFromWalletConcentration).toBe(true);
  });

  it('an unrecognised program is NOT excluded — a creator PDA is program-owned', () => {
    const c = classifyHolder({ owner: 'P', ownerProgram: 'SomeRandomProgram1111111111111111111111111' }, registry);
    expect(c.holderClass).toBe('UNKNOWN');
    expect(c.excludedFromWalletConcentration).toBe(false);
  });

  it('a known trap is never treated as a market', () => {
    resetEntityRegistry();
    const r = loadEntityRegistry();
    for (const trap of r.traps) {
      expect(r.marketPrograms.has(trap)).toBe(false);
      expect(classifyHolder({ owner: 'X', ownerProgram: trap }, r).excludedFromWalletConcentration).toBe(false);
    }
  });
});

describe('19 & 20 — unknown freshness, and no Math.abs on signed impact', () => {
  function info(over: Partial<MintInformation> = {}): MintInformation {
    return {
      id: 'M',
      decimals: 6,
      tokenProgram: paper.gates.allowedTokenPrograms[0],
      holderCount: 10_000,
      liquidity: 1_000_000,
      organicScore: 90,
      audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
      firstPool: { createdAt: new Date(Date.now() - 600_000).toISOString() },
      ...over,
    } as unknown as MintInformation;
  }

  it('a missing updatedAt is unknown, not age zero', () => {
    const unknown = evaluateCheapGates({
      info: info(),
      nowUtcMs: Date.now(),
      sourceAgeMs: null,
      config: paper.gates,
    });
    const fresh = evaluateCheapGates({
      info: info(),
      nowUtcMs: Date.now(),
      sourceAgeMs: 0,
      config: paper.gates,
    });
    // Unknown must NOT produce the same verdict as perfect freshness.
    const unknownNames = unknown.map((g) => g.gate).sort();
    const freshNames = fresh.map((g) => g.gate).sort();
    expect(unknownNames).not.toEqual(freshNames);
    expect(unknownNames).toContain('data_freshness_unknown');
  });

  it('unknown freshness is refused outright where capital is at risk', () => {
    const gated = evaluateCheapGates({
      info: info(),
      nowUtcMs: Date.now(),
      sourceAgeMs: null,
      config: paper.gates,
      capitalAtRisk: true,
    });
    const freshness = gated.find((g) => g.gate === 'data_freshness');
    expect(freshness?.passed).toBe(false);
  });

  it('no source file applies Math.abs to a signed market variable', () => {
    // The grep-style assertion is deliberate. Math.abs on a directional
    // variable has been removed from this tree three times, in three different
    // files, and each time it came back somewhere else.
    const files = [
      'packages/intelligence/src/gates.ts',
      'packages/strategy/src/exits.ts',
      'packages/domain/src/exitoutcome.ts',
      'packages/domain/src/exitdiagnostic.ts',
      'apps/engine/src/paper.ts',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const offending = src
        .split('\n')
        .filter((l) => l.includes('Math.abs(') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
      expect(offending, `${f}: ${offending.join(' | ')}`).toEqual([]);
    }
  });
});

describe('32 — ALT-loaded writable accounts are inspected', () => {
  it('reports every writable account, and the estimate accounts for the table', () => {
    const r = evaluateBuildPolicy(
      {
        instructions: [
          UNIT_LIMIT_IX,
          {
            programId: JUPITER_V6,
            accounts: [
              { pubkey: TAKER, isSigner: true, isWritable: true },
              { pubkey: 'VaultAccount111111111111111111111111111111', isSigner: false, isWritable: true },
              { pubkey: 'ReadOnly11111111111111111111111111111111111', isSigner: false, isWritable: false },
            ],
            data: 'AQ==',
          },
        ],
        lookupTables: { Table1111111111111111111111111111111111111: ['Alt1', 'Alt2'] },
        blockhash: 'HASH',
        lastValidBlockHeight: 100,
      },
      buildPolicyLimits(TAKER, 1_000_000n),
    );
    expect(r.allowed).toBe(true);
    expect(r.writableAccounts).toContain('VaultAccount111111111111111111111111111111');
    expect(r.writableAccounts).not.toContain('ReadOnly11111111111111111111111111111111111');
    expect(r.coverage).toBe('build-response');
  });

  it('31 — a missing lastValidBlockHeight is a violation, not a default', () => {
    const r = evaluateBuildPolicy(
      {
        instructions: [UNIT_LIMIT_IX, { programId: JUPITER_V6, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }] }],
        lookupTables: {},
        blockhash: 'HASH',
        lastValidBlockHeight: null,
      },
      buildPolicyLimits(TAKER, 1_000_000n),
    );
    expect(r.allowed).toBe(false);
    expect(r.violations.map((v) => v.detail).join(' ')).toContain('lastValidBlockHeight');
  });

  it('an unexpected fee payer is refused', () => {
    const r = evaluateBuildPolicy(
      {
        instructions: [
          UNIT_LIMIT_IX,
          { programId: JUPITER_V6, accounts: [{ pubkey: 'SomeoneElse1111111111111111111111111111111', isSigner: true, isWritable: true }] },
        ],
        lookupTables: {},
        blockhash: 'HASH',
        lastValidBlockHeight: 1,
      },
      buildPolicyLimits(TAKER, 1_000_000n),
    );
    expect(r.allowed).toBe(false);
    expect(r.violations.map((v) => v.violation)).toContain('wrong_fee_payer');
  });
});

describe('compute budget — the question the format check was standing in for', () => {
  /**
   * Measured live 2026-08-12: `/swap/v2/build` returns exactly ONE
   * compute-budget instruction and it is always SetComputeUnitPrice, never a
   * limit. `dynamicComputeUnitLimit=true` and `computeUnitPriceMicroLamports=N`
   * both change nothing — the price came back 2054 µL/unit in all four
   * variants. The limit is supplied by whoever assembles the transaction.
   *
   * So "SetComputeUnitLimit must be present" was asserting something about the
   * caller and failing the router for it, and it rejected every real route. The
   * substantive question — can our own fee cap afford a limit a swap could
   * execute within — is asked instead.
   */
  const price = (microLamportsPerUnit: number) => ({
    programId: COMPUTE_BUDGET,
    data: (() => {
      const b = Buffer.alloc(9);
      b[0] = 3;
      b.writeBigUInt64LE(BigInt(microLamportsPerUnit), 1);
      return b.toString('base64');
    })(),
  });
  const swapIx = { programId: JUPITER_V6, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }] };

  it('the observed shape — price only — passes, and the affordable limit is ours', () => {
    const cb = evaluateComputeBudget([price(2054), swapIx], 1_000_000n);
    expect(cb.violation).toBeNull();
    expect(cb.unitLimit).toBeNull();
    expect(cb.unitPriceMicroLamports).toBe(2054n);
    // 1_000_000 lamports at 2054 µL/unit buys far more than the chain permits,
    // so the cap is the chain ceiling rather than our wallet.
    expect(cb.affordableUnitLimit).toBe(MAX_COMPUTE_UNITS);
  });

  it('a price our fee cap cannot afford IS refused', () => {
    // 10_000_000 µL/unit against a 1_000_000 lamport cap buys 100_000 units,
    // below what a swap needs. That is a real economic refusal.
    const cb = evaluateComputeBudget([price(10_000_000), swapIx], 1_000_000n);
    expect(cb.violation?.violation).toBe('priority_fee_too_high');
    expect(cb.affordableUnitLimit).toBeLessThan(MIN_PLAUSIBLE_COMPUTE_UNITS);
  });

  it('the affordable limit tracks OUR cap, not the chain ceiling', () => {
    const generous = evaluateComputeBudget([price(1_000_000), swapIx], 1_000_000n);
    const stingy = evaluateComputeBudget([price(1_000_000), swapIx], 500_000n);
    expect(generous.affordableUnitLimit).toBe(1_000_000);
    expect(stingy.affordableUnitLimit).toBe(500_000);
    // Halving the cap halves what it buys. A limit that ignored the cap would
    // return the same number twice.
    expect(stingy.affordableUnitLimit).toBeLessThan(generous.affordableUnitLimit ?? 0);
  });

  it('neither a limit nor a price is UNKNOWN, and unknown is refused', () => {
    const cb = evaluateComputeBudget([swapIx], 1_000_000n);
    expect(cb.violation?.violation).toBe('compute_limit_missing');
    expect(cb.affordableUnitLimit).toBeNull();
  });

  it('a limit with no price passes: no price means no priority fee at all', () => {
    const cb = evaluateComputeBudget([UNIT_LIMIT_IX, swapIx], 1_000_000n);
    expect(cb.violation).toBeNull();
    expect(cb.unitLimit).toBe(200_000);
  });

  it('both present, over the cap, is refused on the fee the response determines', () => {
    const cb = evaluateComputeBudget([UNIT_LIMIT_IX, price(1_000_000_000), swapIx], 1_000n);
    expect(cb.violation?.violation).toBe('priority_fee_too_high');
  });
});
