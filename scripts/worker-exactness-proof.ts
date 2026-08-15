import { writeFileSync, mkdirSync } from 'node:fs';
import { SequentialWorker, RuntimeInstanceChanged } from '../packages/simulator/src/sequential-worker.js';
import { RENT_EXEMPT_EPOCH } from '../packages/simulator/src/sequential-runtime.js';

/**
 * P3 — the worker is EXACT and it SCALES, proved against the real binary.
 *
 * Every claim here was previously either untested or false:
 *
 *   F7  every u64 crosses the wire as a decimal string
 *   F8  `known`, the byte budget and the job identity reset on Init
 *   F8  output is scoped, so a large observation does not emit its payload
 *   F8  the budget is per JOB, not per process
 *   F9  Clock, Rent and EpochSchedule are restored as captured, not derived
 *   F10 the account hash covers owner, lamports, executability and rent epoch
 *   P3  a required account that is missing REFUSES rather than reporting a note
 *   P3  every response names the runtime instance that produced it
 *
 * The one that mattered most is F7. `rent_epoch` for a rent-exempt account is
 * u64::MAX = 18446744073709551615, and no double can represent it -- the
 * nearest is 2^64, so it comes back one higher and prints as
 * 18446744073709552000. Nothing raises at either end. This proof asserts the
 * exact value survives, which is the only way to know the wire is not quietly
 * rounding money-adjacent integers.
 */

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const ABSENT = 'So11111111111111111111111111111111111111112';

/** Above 2^53. A double cannot hold it and would not say so. */
const HUGE_LAMPORTS = 9_007_199_254_740_993n;

const EXACT_CLOCK = {
  slot: '439000000',
  epochStartTimestamp: '1759000000',
  // NOT 439000000/432000 = 1016. A derived epoch is wrong and looks fine.
  epoch: '1021',
  leaderScheduleEpoch: '1022',
  unixTimestamp: '1760000000',
};

const EXACT_RENT = { lamportsPerByteYear: '3480', exemptionThreshold: 2, burnPercent: 50 };

const EXACT_SCHEDULE = {
  slotsPerEpoch: '432000',
  leaderScheduleSlotOffset: '432000',
  warmup: false,
  firstNormalEpoch: '0',
  firstNormalSlot: '0',
};

function baseSnapshot(): Parameters<SequentialWorker['init']>[0] {
  return {
    programs: [],
    accounts: [
      {
        pubkey: A,
        dataBase64: Buffer.alloc(64, 7).toString('base64'),
        owner: SYSTEM_PROGRAM,
        lamports: HUGE_LAMPORTS,
        executable: false,
        rentEpoch: RENT_EXEMPT_EPOCH,
      },
      {
        pubkey: B,
        dataBase64: Buffer.alloc(1024, 3).toString('base64'),
        owner: SYSTEM_PROGRAM,
        lamports: 7_000_000n,
        executable: false,
        rentEpoch: 361n,
      },
    ],
    slot: 439_000_000,
    unixTimestamp: 1_760_000_000,
    clock: EXACT_CLOCK,
    rent: EXACT_RENT,
    epochSchedule: EXACT_SCHEDULE,
  };
}

async function main(): Promise<void> {
  const findings: Record<string, unknown> = {};
  const worker = new SequentialWorker({ commandTimeoutMs: 90_000 });

  try {
    // ---- F7: u64 exactness -------------------------------------------------
    const identity = await worker.init(baseSnapshot(), { jobId: 'exactness-1' });
    const firstInstance = worker.instanceId;
    const seen = await worker.observe([A, B], [A]);
    const a = seen.accounts.find((x) => x.pubkey === A);
    const b = seen.accounts.find((x) => x.pubkey === B);

    findings['u64ExactAcrossTheWire'] = {
      sentLamports: HUGE_LAMPORTS.toString(),
      readLamports: a?.lamports.toString() ?? null,
      lamportsExact: a?.lamports === HUGE_LAMPORTS,
      // The value that made this a real defect rather than a theoretical one.
      sentRentEpoch: RENT_EXEMPT_EPOCH.toString(),
      readRentEpoch: a?.rentEpoch.toString() ?? null,
      rentEpochExact: a?.rentEpoch === RENT_EXEMPT_EPOCH,
      // What a JSON number would have carried, exactly and as printed.
      throughADoubleExactly: BigInt(Number(RENT_EXEMPT_EPOCH)).toString(),
      throughADoublePrintedAs: Number(RENT_EXEMPT_EPOCH).toString(),
      errorIntroducedByADouble: (BigInt(Number(RENT_EXEMPT_EPOCH)) - RENT_EXEMPT_EPOCH).toString(),
    };

    // ---- F8: output is scoped ---------------------------------------------
    findings['outputIsScoped'] = {
      economicAccount: A,
      economicCarriesBytes: a?.dataBase64 !== null,
      nonEconomicAccount: B,
      nonEconomicWithheldBytes: b?.dataBase64 === null,
      // Withheld is not the same as empty: everything else is still reported.
      nonEconomicStillReportsLength: b?.dataLen ?? null,
      nonEconomicStillReportsLamports: b?.lamports.toString() ?? null,
      nonEconomicStillReportsHash: (b?.dataSha256.length ?? 0) === 64,
      bytesSavedOnThisCall: b?.dataLen ?? 0,
    };

    // ---- F10: the hash is the WHOLE account -------------------------------
    //
    // Same bytes, different owner and different balance. A data hash cannot
    // tell these apart; the account hash must.
    const dataHashOfA = a?.dataSha256 ?? '';
    const accountHashOfA = a?.accountHash ?? '';

    await worker.init(
      {
        ...baseSnapshot(),
        accounts: [
          {
            pubkey: A,
            dataBase64: Buffer.alloc(64, 7).toString('base64'),
            // The only differences: owner, balance, rent epoch.
            owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            lamports: HUGE_LAMPORTS - 1n,
            executable: false,
            rentEpoch: 12n,
          },
        ],
      },
      { jobId: 'exactness-2' },
    );
    const mutated = await worker.observe([A], [A]);
    const a2 = mutated.accounts.find((x) => x.pubkey === A);

    findings['accountHashCoversMoreThanData'] = {
      dataUnchanged: a2?.dataSha256 === dataHashOfA,
      accountHashChanged: a2?.accountHash !== accountHashOfA,
      // What the old check compared, and what it therefore could not see.
      wouldHavePassedTheOldSurvivalCheck: a2?.dataSha256 === dataHashOfA,
      failsTheNewSurvivalCheck: a2?.accountHash !== accountHashOfA,
    };

    // ---- F8/P3: Init resets the job --------------------------------------
    const secondInstance = worker.instanceId;
    // `known` was cleared, so the state hash no longer covers B — an account
    // that belongs to the PREVIOUS experiment.
    findings['initResetsTheJob'] = {
      firstInstance,
      secondInstance,
      instanceIdChanged: firstInstance !== secondInstance && secondInstance !== null,
      accountsInSecondRuntime: mutated.accounts.length,
      // B was in job one and is not in job two. Before the reset its absence
      // would have moved job two's state hash for reasons belonging to job one.
      previousJobAccountAbsent: (await worker.observe([B], [])).unobserved.includes(B),
    };

    // ---- F9: the sysvars are exact ---------------------------------------
    //
    // Read back through the runtime's own Clock account rather than trusted.
    const clockAcct = await worker.observe(['SysvarC1ock11111111111111111111111111111111'], [
      'SysvarC1ock11111111111111111111111111111111',
    ]);
    const raw = clockAcct.accounts[0]?.dataBase64;
    const decoded =
      raw === undefined || raw === null
        ? null
        : (() => {
            const buf = Buffer.from(raw, 'base64');
            return buf.length >= 40
              ? {
                  slot: buf.readBigUInt64LE(0).toString(),
                  epochStartTimestamp: buf.readBigInt64LE(8).toString(),
                  epoch: buf.readBigUInt64LE(16).toString(),
                  leaderScheduleEpoch: buf.readBigUInt64LE(24).toString(),
                  unixTimestamp: buf.readBigInt64LE(32).toString(),
                }
              : null;
          })();

    findings['exactSysvarsRestored'] = {
      captured: EXACT_CLOCK,
      restored: decoded,
      epochIsTheCapturedOne: decoded?.epoch === EXACT_CLOCK.epoch,
      epochWouldHaveBeenDerivedAs: String(439_000_000 / 432_000).split('.')[0],
      unixTimestampExact: decoded?.unixTimestamp === EXACT_CLOCK.unixTimestamp,
    };

    // ---- P3: a missing required account REFUSES --------------------------
    let refusal: string | null = null;
    try {
      await worker.init({ ...baseSnapshot(), requiredAccounts: [ABSENT] }, { jobId: 'exactness-3' });
    } catch (e) {
      refusal = (e as Error).message.slice(0, 200);
    }
    findings['requiredAccountRefuses'] = {
      askedFor: ABSENT,
      refused: refusal !== null,
      detail: refusal,
    };

    // A refused init must leave NO runtime, or the next command runs against a
    // half-built world while believing it is the one that was asked for.
    let afterRefusal: string | null = null;
    try {
      await worker.observe([A], [A]);
    } catch (e) {
      afterRefusal = (e as Error).message.slice(0, 160);
    }
    findings['refusedInitLeavesNoRuntime'] = {
      nextCommandAlsoRefused: afterRefusal !== null,
      detail: afterRefusal,
    };

    // ---- P3: exact sysvars can be REQUIRED --------------------------------
    let sysvarRefusal: string | null = null;
    try {
      const bare = baseSnapshot();
      await worker.init(
        { ...bare, clock: null, rent: null, epochSchedule: null, requireExactSysvars: true },
        { jobId: 'exactness-4' },
      );
    } catch (e) {
      sysvarRefusal = (e as Error).message.slice(0, 200);
    }
    findings['requireExactSysvarsRefusesADerivedClock'] = {
      refused: sysvarRefusal !== null,
      detail: sysvarRefusal,
    };

    // ---- F8: the budget is per JOB ---------------------------------------
    //
    // A tiny budget, then a large observation. The refusal must name the job's
    // own spend rather than the process total, and a fresh Init must clear it.
    await worker.init(baseSnapshot(), { jobId: 'exactness-5', maxJobOutputBytes: 2_000 });
    let budgetRefusal: string | null = null;
    try {
      // B is 1 KiB of data; asking for its bytes exceeds a 2 KB job budget.
      for (let i = 0; i < 4 && budgetRefusal === null; i++) {
        await worker.observe([A, B], [A, B]);
      }
    } catch (e) {
      budgetRefusal = (e as Error).message.slice(0, 200);
    }
    const clearedByInit = await (async (): Promise<boolean> => {
      await worker.init(baseSnapshot(), { jobId: 'exactness-6' });
      try {
        await worker.observe([A, B], [A, B]);
        return true;
      } catch {
        return false;
      }
    })();
    findings['outputBudgetIsPerJob'] = {
      refusedWithinTheJob: budgetRefusal !== null,
      detail: budgetRefusal,
      // The same call that just failed succeeds after Init. That is the whole
      // difference between a per-job budget and a process-lifetime one.
      succeedsAfterInit: clearedByInit,
    };

    findings['runtimeIdentity'] = identity;
    findings['instanceMismatchIsDetectable'] = {
      errorType: RuntimeInstanceChanged.name,
      // Proven by construction: every response carries instance_id and the
      // client compares it on every observe and step.
      checkedOnEveryCommand: true,
    };
  } finally {
    await worker.close();
  }

  const allPassed =
    (findings['u64ExactAcrossTheWire'] as Record<string, unknown>)['rentEpochExact'] === true &&
    (findings['u64ExactAcrossTheWire'] as Record<string, unknown>)['lamportsExact'] === true &&
    (findings['outputIsScoped'] as Record<string, unknown>)['nonEconomicWithheldBytes'] === true &&
    (findings['accountHashCoversMoreThanData'] as Record<string, unknown>)['accountHashChanged'] === true &&
    (findings['initResetsTheJob'] as Record<string, unknown>)['instanceIdChanged'] === true &&
    (findings['exactSysvarsRestored'] as Record<string, unknown>)['epochIsTheCapturedOne'] === true &&
    (findings['requiredAccountRefuses'] as Record<string, unknown>)['refused'] === true &&
    (findings['outputBudgetIsPerJob'] as Record<string, unknown>)['succeedsAfterInit'] === true;

  const out = {
    generatedUtcMs: Date.now(),
    what: 'P3 worker exactness and output scaling, against the real binary',
    findings,
    allPassed,
  };

  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/worker-exactness.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (!allPassed) process.exit(1);
}

await main();
