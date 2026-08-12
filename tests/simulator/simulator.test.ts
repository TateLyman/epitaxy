import { describe, it, expect } from 'vitest';
import { DeterministicFixtureSimulator, fixtureKey } from '../../packages/simulator/src/fixture.js';
import {
  surfpoolAvailable,
  snapshotManifestHash,
  buildSnapshot,
  SurfpoolSimulator,
  SurfpoolUnavailable,
} from '../../packages/simulator/src/surfpool.js';
import { isConfirmatorySimulation } from '../../packages/simulator/src/types.js';
import type { SimulationResult, SnapshotAccount } from '../../packages/simulator/src/types.js';
import { priorityFeeLamports } from '../../packages/solana/src/transaction.js';

/**
 * §6 — the simulator, and the boundary around what it is allowed to prove.
 *
 * These run on every platform. The Surfpool-specific ones are skipped where no
 * native binary exists rather than faked, because a test that cannot fail on
 * the machine running it is not evidence that anything works there.
 */

const account = (over: Partial<SnapshotAccount> = {}): SnapshotAccount => ({
  pubkey: 'Acc1',
  owner: '11111111111111111111111111111111',
  lamports: 1_000n,
  dataBase64: 'AA==',
  executable: false,
  rentEpoch: null,
  slot: 100,
  ...over,
});

describe('a fixture simulator never invents a result', () => {
  it('returns SIMULATOR_UNAVAILABLE for a transaction it has not seen', async () => {
    const sim = new DeterministicFixtureSimulator(new Map());
    await sim.start();
    const r = await sim.simulate('unseen');
    expect(r.verdict).toBe('SIMULATOR_UNAVAILABLE');
    expect(r.unitsConsumed).toBeNull();
    await sim.stop();
  });

  it('replays a recorded outcome exactly', async () => {
    const tx = 'AQIDBA==';
    const sim = new DeterministicFixtureSimulator(
      new Map([[fixtureKey(tx), { verdict: 'SIMULATED_OK' as const, unitsConsumed: 142_000 }]]),
    );
    await sim.start();
    const r = await sim.simulate(tx);
    expect(r.verdict).toBe('SIMULATED_OK');
    expect(r.unitsConsumed).toBe(142_000);
    await sim.stop();
  });

  it('is deterministic: the same input twice gives the same output', async () => {
    const tx = 'AQIDBA==';
    const sim = new DeterministicFixtureSimulator(
      new Map([[fixtureKey(tx), { verdict: 'SIMULATED_OK' as const, unitsConsumed: 1 }]]),
    );
    await sim.start();
    const a = await sim.simulate(tx);
    const b = await sim.simulate(tx);
    expect(a.verdict).toBe(b.verdict);
    expect(a.unitsConsumed).toBe(b.unitsConsumed);
    await sim.stop();
  });

  it('refuses to be used before start()', async () => {
    const sim = new DeterministicFixtureSimulator(new Map());
    await expect(sim.simulate('x')).rejects.toThrow(/before start/);
  });
});

describe('a fixture pass is never confirmatory evidence', () => {
  /**
   * The single most important property in this module. A fixture replays a
   * recorded outcome; it executes nothing. If it could back a confirmatory row
   * then the confirmatory corpus would be a recording of itself.
   */
  const passing = (over: Partial<SimulationResult> = {}): SimulationResult => ({
    verdict: 'SIMULATED_OK',
    unitsConsumed: 100,
    logs: [],
    error: null,
    lamportDeltas: {},
    tokenDeltas: {},
    createdAccounts: [],
    closedAccounts: [],
    simulator: {
      kind: 'fixture',
      packageVersion: 'fixture-v1',
      runtimeVersion: null,
      featureSet: null,
      binaryHash: null,
      isAuthoritative: false,
    },
    snapshotHash: 'snap',
    latencyMs: 0,
    detail: '',
    ...over,
  });

  it('a passing fixture result is not confirmatory', () => {
    expect(isConfirmatorySimulation(passing())).toBe(false);
  });

  it('an authoritative pass WITH a snapshot is confirmatory', () => {
    expect(
      isConfirmatorySimulation(
        passing({
          simulator: { ...passing().simulator, kind: 'surfpool', isAuthoritative: true },
        }),
      ),
    ).toBe(true);
  });

  it('an authoritative pass WITHOUT a snapshot is not — a JIT run is not reproducible', () => {
    expect(
      isConfirmatorySimulation(
        passing({
          simulator: { ...passing().simulator, kind: 'surfpool', isAuthoritative: true },
          snapshotHash: null,
        }),
      ),
    ).toBe(false);
  });

  it('a failure is never confirmatory however authoritative', () => {
    expect(
      isConfirmatorySimulation(
        passing({
          verdict: 'SIMULATION_FAILED',
          simulator: { ...passing().simulator, isAuthoritative: true },
        }),
      ),
    ).toBe(false);
  });
});

describe('an account snapshot is content-addressed', () => {
  it('the same accounts hash the same regardless of order', () => {
    const a = account({ pubkey: 'A' });
    const b = account({ pubkey: 'B' });
    expect(snapshotManifestHash([a, b])).toBe(snapshotManifestHash([b, a]));
  });

  it('the same account at a different slot is different evidence', () => {
    expect(snapshotManifestHash([account({ slot: 1 })])).not.toBe(snapshotManifestHash([account({ slot: 2 })]));
  });

  it('changed data changes the hash', () => {
    expect(snapshotManifestHash([account({ dataBase64: 'AA==' })])).not.toBe(
      snapshotManifestHash([account({ dataBase64: 'AQ==' })]),
    );
  });

  it('slot drift against the build context slot is recorded rather than smoothed', () => {
    const clean = buildSnapshot([account({ slot: 100 })], 100, 0);
    expect(clean.hasSlotDrift).toBe(false);
    const drifted = buildSnapshot([account({ slot: 105 })], 100, 0);
    expect(drifted.hasSlotDrift).toBe(true);
  });
});

describe('surfpool availability is reported, never assumed', () => {
  it('names the platform reason rather than failing silently', () => {
    const a = surfpoolAvailable();
    expect(typeof a.available).toBe('boolean');
    expect(a.reason.length).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      expect(a.available).toBe(false);
      expect(a.reason).toMatch(/win32|WSL/);
    }
  });

  it('starting on win32 throws a typed error that says where to run it', async () => {
    if (process.platform !== 'win32') return;
    const sim = new SurfpoolSimulator();
    await expect(sim.start()).rejects.toThrow(SurfpoolUnavailable);
  });

  it('an unstarted simulator refuses to be driven', async () => {
    const sim = new SurfpoolSimulator();
    await expect(sim.fundSol('X', 1n)).rejects.toThrow(SurfpoolUnavailable);
  });
});

describe('§4.1 — the priority fee uses the chain formula', () => {
  /**
   * The runtime charges ceil(unit_price * limit / 1e6). Flooring understates it
   * by up to a lamport on every transaction that does not divide evenly, always
   * in the same direction, in a system trying to measure a thin edge.
   */
  it('rounds UP, so one micro-lamport-unit is one lamport and not zero', () => {
    expect(priorityFeeLamports({ unitLimit: 1, unitPriceMicroLamports: 1n })).toBe(1n);
  });

  it('an exact multiple is unchanged', () => {
    expect(priorityFeeLamports({ unitLimit: 1_000_000, unitPriceMicroLamports: 1n })).toBe(1n);
    expect(priorityFeeLamports({ unitLimit: 2_000_000, unitPriceMicroLamports: 1n })).toBe(2n);
  });

  it('one unit above an exact multiple costs the next whole lamport', () => {
    expect(priorityFeeLamports({ unitLimit: 1_000_001, unitPriceMicroLamports: 1n })).toBe(2n);
  });

  it('the observed router price at a real limit', () => {
    // 2054 µL/unit was the live figure from /swap/v2/build on 2026-08-12.
    // 200_000 * 2054 / 1e6 = 410.8 -> 411, not 410.
    expect(priorityFeeLamports({ unitLimit: 200_000, unitPriceMicroLamports: 2054n })).toBe(411n);
  });

  it('zero stays zero rather than becoming one', () => {
    expect(priorityFeeLamports({ unitLimit: 0, unitPriceMicroLamports: 2054n })).toBe(0n);
    expect(priorityFeeLamports({ unitLimit: 200_000, unitPriceMicroLamports: 0n })).toBe(0n);
    expect(priorityFeeLamports({ unitLimit: null, unitPriceMicroLamports: 2054n })).toBe(0n);
  });
});
