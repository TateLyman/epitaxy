/**
 * P13 — the size surface, measured on true sequential lifecycles.
 *
 * The retired version generalised from raw acquired atoms at one 0.02 SOL
 * notional and produced a "mechanical cliff at ~10^9 atoms". Raw atoms move
 * with decimals, supply and price, so a threshold on them is a threshold on
 * three unrelated things wearing one number. Everything here is dimensionless
 * or a lamport cost, and every figure comes from a buy, a sell and a close
 * that committed in ONE runtime state.
 *
 * The three setup cases the directive separates are not a classification
 * applied afterwards; they are measured. An account that did not exist before
 * the sequence and holds lamports after it was CREATED, and its rent-exempt
 * minimum is a cost this trade paid and the next trade on the same mint will
 * not.
 *
 * The development notional is chosen PROSPECTIVELY — smallest size clearing the
 * mechanics gate, minimising robust capital at risk — and nothing here looks at
 * a return.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadSecrets, loadConfig } from '../packages/domain/src/config.js';
import { openDb } from '../packages/storage/src/db.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { compileMessage, encodeUnsignedTransaction } from '../packages/solana/src/encode.js';
import { captureSnapshot } from '../packages/solana/src/snapshot-capture.js';
import {
  runSequential,
  tokenAmountOf,
  createdAccountRent,
  createdAccountRentAcross,
  rentExemptLamports,
} from '../packages/simulator/src/sequential-runtime.js';
import { buildCloseAccount } from '../packages/solana/src/closeaccount.js';
import {
  accountSourceOf,
  overlaySource,
  buildBuyFrom,
  buildSellFrom,
  quoteSellFrom,
  poolAddressesFrom,
  poolFactsFrom,
  canonicalPool,
  swapAccountAddresses,
  associatedTokenAddressOf,
  SWAP_PROGRAM_IDS,
  WSOL_MINT,
} from '../packages/solana/src/pumpswap-offline.js';
import { classifyRoundTrip } from '../packages/domain/src/statefulness.js';
import { currentProvenance } from '../packages/research/src/artifact-provenance.js';
import type { RawInstruction } from '../packages/solana/src/instructionpolicy.js';
import type { TransactionInstruction } from '@solana/web3.js';

/** Preregistered. Frozen before any result and not revised after one. */
const GRID: readonly bigint[] = [1_000_000n, 2_500_000n, 5_000_000n, 10_000_000n, 20_000_000n, 40_000_000n];
const SLIPPAGE_PCT = 3;
const TARGET_MINTS = Number(process.env['SURFACE_MINTS'] ?? 5);
/** What a real entry pays above the swap. Measured from production's own builds. */
const PRIORITY_AND_TIP_LAMPORTS = 40_000n;

const secrets = loadSecrets();
const config = loadConfig('paper');
const db = openDb({ path: secrets.databasePath, readonly: true });
if (secrets.paperTakerPubkey === null || secrets.rpcHttp === null) {
  console.error('PAPER_TAKER_PUBKEY and an RPC endpoint are both required');
  process.exit(1);
}
const taker: string = secrets.paperTakerPubkey;
const { rpc, host: rpcHost, overridden } = researchRpc(secrets);
console.log(`endpoint ${rpcHost}${overridden ? ' (explicit override)' : ''}`);
void config;

const toRaw = (ix: TransactionInstruction): RawInstruction => ({
  programId: ix.programId.toBase58(),
  accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString('base64'),
});

/** bigint ratio in bps, never through a float. */
const ratioBps = (a: bigint, b: bigint): number | null => (b === 0n ? null : Number((a * 10_000n) / b));

interface Point {
  mint: string;
  pool: string;
  notionalLamports: string;
  baseTokenProgram: string | null;
  decimals: number | null;

  /** ---- dimensionless position size, the part that ports across tokens ---- */
  positionOverMintSupplyBps: number | null;
  positionOverBaseReserveBps: number | null;
  notionalOverEffectiveQuoteReserveBps: number | null;
  /** One atom, priced. Below this the size cannot be represented at all. */
  minimumRepresentableOutputLamports: string | null;

  /** ---- what the lifecycle actually did ---------------------------------- */
  buyStatus: string | null;
  sellStatus: string | null;
  closeStatus: string | null;
  acquiredAtoms: string | null;
  sellCapacityAtoms: string | null;
  /** Every atom the buy credited could be sold back. */
  fullExitPossible: boolean | null;

  /** ---- costs, separated by whether a repeat trade pays them -------------- */
  ammDragLamports: string | null;
  ammDragBps: number | null;
  entryAtaRentLamports: string | null;
  entryAtaRentRecovered: boolean | null;
  setupRentLamports: string | null;
  setupAccounts: string[];
  baseFeeLamports: string;
  priorityAndTipLamports: string;

  /** ---- the three cases the directive separates -------------------------- */
  firstWalletSetupNetLamports: string | null;
  firstMintSetupNetLamports: string | null;
  repeatTradeNetLamports: string | null;
  repeatTradeDragBps: number | null;
  /**
   * What the payer lost that no named component accounts for.
   *
   * Reported rather than folded into the repeat-trade figure. A residual with a
   * name is a measurement; a residual absorbed into a cost is that cost being
   * wrong by an amount nobody can see.
   */
  unexplainedResidualLamports: string | null;

  /** ---- latency: what a delayed exit costs at this size ------------------ */
  exitAfterOneBlockLamports: string | null;
  latencySensitivityBps: number | null;

  evidenceClass: string | null;
  status: string;
  detail: string | null;
}

const candidates = db
  .prepare(
    `SELECT DISTINCT mint FROM execution_observations
      WHERE side='buy' AND exact_transaction_blob IS NOT NULL AND received_utc_ms > ?
      ORDER BY received_utc_ms DESC LIMIT 400`,
  )
  .all(Date.now() - 7 * 86_400_000) as { mint: string }[];

const points: Point[] = [];
const mintsDone: string[] = [];
console.log(`${candidates.length} candidates, grid ${GRID.map(String).join(' ')}, target ${TARGET_MINTS} mints\n`);

for (const c of candidates) {
  if (mintsDone.length >= TARGET_MINTS) break;

  const pool = canonicalPool(c.mint);
  let addrs;
  try {
    const raw = await rpc.getAccountRaw(pool);
    addrs = poolAddressesFrom(
      accountSourceOf([{ pubkey: pool, owner: raw.owner, dataBase64: raw.dataBase64, lamports: raw.lamports }]),
      pool,
    );
  } catch {
    continue; // no canonical pool: still on the bonding curve. A market fact.
  }

  const takerWsol = associatedTokenAddressOf(taker, WSOL_MINT, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const wanted = [
    taker,
    takerWsol,
    addrs.poolBaseTokenAccount,
    addrs.poolQuoteTokenAccount,
    ...swapAccountAddresses({ poolKey: pool, baseMint: c.mint, user: taker, coinCreator: addrs.coinCreator }),
  ];

  let snapshot;
  try {
    snapshot = await captureSnapshot(rpc, [], { extraAccounts: wanted, extraPrograms: [...SWAP_PROGRAM_IDS] });
  } catch (e) {
    console.log(`  ${c.mint.slice(0, 10)} INSTRUMENT_SNAPSHOT_FAILED ${(e as Error).message.slice(0, 70)}`);
    continue;
  }
  if (snapshot.programs.length === 0) continue;

  const preSrc = accountSourceOf(snapshot.accounts);
  let facts;
  try {
    facts = poolFactsFrom(preSrc, pool);
  } catch {
    continue;
  }
  const takerAta = associatedTokenAddressOf(taker, c.mint, facts.baseTokenProgram);
  const mintBytes = preSrc.get(c.mint);
  const decimals = mintBytes === null ? null : Buffer.from(mintBytes.dataBase64, 'base64').readUInt8(44);
  const supply = mintBytes === null ? null : Buffer.from(mintBytes.dataBase64, 'base64').readBigUInt64LE(36);
  const effectiveQuote = facts.quoteReserveRaw + facts.virtualQuoteReserves;

  const accounts = [
    ...snapshot.accounts.map((a) => (a.pubkey === taker ? { ...a, lamports: 8_000_000_000n } : a)),
    ...(snapshot.accounts.some((a) => a.pubkey === taker)
      ? []
      : [
          {
            pubkey: taker,
            dataBase64: '',
            owner: '11111111111111111111111111111111',
            lamports: 8_000_000_000n,
            executable: false,
            rentEpoch: 0n,
          },
        ]),
  ];
  const baseObserve = [...new Set([...wanted, takerAta, pool])];

  console.log(`${c.mint.slice(0, 12)}  decimals ${decimals}  supply ${supply}`);
  let anyPoint = false;

  for (const notional of GRID) {
    const p: Point = {
      mint: c.mint,
      pool,
      notionalLamports: notional.toString(),
      baseTokenProgram: facts.baseTokenProgram,
      decimals,
      positionOverMintSupplyBps: null,
      positionOverBaseReserveBps: null,
      notionalOverEffectiveQuoteReserveBps: ratioBps(notional, effectiveQuote),
      minimumRepresentableOutputLamports: null,
      buyStatus: null,
      sellStatus: null,
      closeStatus: null,
      acquiredAtoms: null,
      sellCapacityAtoms: null,
      fullExitPossible: null,
      ammDragLamports: null,
      ammDragBps: null,
      entryAtaRentLamports: null,
      entryAtaRentRecovered: null,
      setupRentLamports: null,
      setupAccounts: [],
      baseFeeLamports: '5000',
      priorityAndTipLamports: PRIORITY_AND_TIP_LAMPORTS.toString(),
      firstWalletSetupNetLamports: null,
      firstMintSetupNetLamports: null,
      repeatTradeNetLamports: null,
      repeatTradeDragBps: null,
      unexplainedResidualLamports: null,
      exitAfterOneBlockLamports: null,
      latencySensitivityBps: null,
      evidenceClass: null,
      status: 'PENDING',
      detail: null,
    };

    const fail = (status: string, detail?: string): void => {
      p.status = status;
      if (detail !== undefined) p.detail = detail.slice(0, 150);
      points.push(p);
      console.log(`    ${String(notional).padStart(9)}  ${status}${detail === undefined ? '' : ` ${detail.slice(0, 60)}`}`);
    };

    let buyBytes: string;
    let buyAccounts: readonly string[];
    try {
      const built = await buildBuyFrom(preSrc, {
        poolKey: pool,
        user: taker,
        quoteLamports: notional,
        slippagePct: SLIPPAGE_PCT,
      });
      buyAccounts = built.accounts;
      buyBytes = Buffer.from(
        encodeUnsignedTransaction(
          compileMessage(built.instructions.map(toRaw), taker, '11111111111111111111111111111111', {}),
        ),
      ).toString('base64');
    } catch (e) {
      fail('BUY_UNBUILDABLE', (e as Error).message);
      continue;
    }

    // Pass one: the buy alone, to read the committed post-buy state.
    let pass1;
    try {
      pass1 = runSequential({
        jobId: `surface-${c.mint.slice(0, 8)}-${notional}`,
        snapshot: {
          programs: snapshot.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 })),
          accounts,
          slot: snapshot.slot,
          unixTimestamp: snapshot.unixTimestamp,
        },
        steps: [{ label: 'buy', transactionBase64: buyBytes, observe: baseObserve }],
        timeoutMs: 180_000,
      });
    } catch (e) {
      fail('INSTRUMENT_RUNTIME_FAILED', (e as Error).message);
      continue;
    }
    const buyStep = pass1.steps[0];
    p.buyStatus = buyStep?.status ?? 'MISSING';
    if (buyStep === undefined || buyStep.status !== 'SIMULATED_OK') {
      fail('BUY_FAILED_IN_RUNTIME', buyStep?.transactionError ?? 'no result');
      continue;
    }

    const ataAfter = buyStep.postAccounts.find((a) => a.pubkey === takerAta);
    const acquired = ataAfter === undefined ? null : tokenAmountOf(ataAfter);
    if (acquired === null || acquired <= 0n) {
      fail('NO_MEASURED_CREDIT', 'the buy committed and credited nothing');
      continue;
    }
    p.acquiredAtoms = acquired.toString();
    p.positionOverMintSupplyBps = supply === null ? null : ratioBps(acquired, supply);
    p.positionOverBaseReserveBps = ratioBps(acquired, facts.baseReserve);

    const postSrc = overlaySource(preSrc, accountSourceOf(buyStep.postAccounts));

    // The smallest output the market can represent: one atom, priced.
    try {
      p.minimumRepresentableOutputLamports = quoteSellFrom(postSrc, pool, 1n, SLIPPAGE_PCT).quoteOutLamports.toString();
    } catch {
      /* recorded as null; the quote below will report the real problem */
    }

    let sellBytes: string;
    let sellAccounts: readonly string[];
    let quoted: bigint;
    try {
      const q = quoteSellFrom(postSrc, pool, acquired, SLIPPAGE_PCT);
      quoted = q.quoteOutLamports;
      const built = await buildSellFrom(postSrc, {
        poolKey: pool,
        user: taker,
        baseAtoms: acquired,
        slippagePct: SLIPPAGE_PCT,
      });
      sellAccounts = built.accounts;
      sellBytes = Buffer.from(
        encodeUnsignedTransaction(
          compileMessage(built.instructions.map(toRaw), taker, '11111111111111111111111111111111', {}),
        ),
      ).toString('base64');
    } catch (e) {
      fail('SELL_UNBUILDABLE', (e as Error).message);
      continue;
    }
    p.ammDragLamports = (quoted - notional).toString();
    p.ammDragBps = ratioBps(notional - quoted, notional);

    const closeBytes = Buffer.from(
      encodeUnsignedTransaction(
        compileMessage(
          [
            buildCloseAccount({
              tokenAccount: takerAta,
              destination: taker,
              owner: taker,
              tokenProgram: facts.baseTokenProgram,
              residualAtoms: 0n,
              withheldAtoms: 0n,
            }),
          ],
          taker,
          '11111111111111111111111111111111',
          {},
        ),
      ),
    ).toString('base64');

    // BOTH legs' account lists. Observing only the sell's left an account the
    // BUY opened outside the reading entirely, and its two million lamports
    // came out as an unexplained shortfall attributed to the trade's economics.
    const observe = [...new Set([...baseObserve, ...buyAccounts, ...sellAccounts])];
    let pass2;
    try {
      pass2 = runSequential({
        jobId: `surface-${c.mint.slice(0, 8)}-${notional}-full`,
        snapshot: {
          programs: snapshot.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 })),
          accounts,
          slot: snapshot.slot,
          unixTimestamp: snapshot.unixTimestamp,
        },
        steps: [
          { label: 'buy', transactionBase64: buyBytes, observe },
          { label: 'sell', transactionBase64: sellBytes, observe },
          { label: 'close', transactionBase64: closeBytes, observe },
        ],
        timeoutMs: 300_000,
      });
    } catch (e) {
      fail('INSTRUMENT_RUNTIME_FAILED', (e as Error).message);
      continue;
    }

    const [b2, sellStep, closeStep] = pass2.steps;
    p.sellStatus = sellStep?.status ?? 'MISSING';
    p.closeStatus = closeStep?.status ?? 'MISSING';
    if (b2 === undefined || sellStep === undefined || sellStep.status !== 'SIMULATED_OK') {
      fail('SELL_FAILED_IN_RUNTIME', sellStep?.transactionError ?? 'no result');
      continue;
    }
    const residual = (() => {
      const a = sellStep.postAccounts.find((x) => x.pubkey === takerAta);
      return a === undefined ? null : tokenAmountOf(a);
    })();
    p.sellCapacityAtoms = residual === null ? null : (acquired - residual).toString();
    p.fullExitPossible = residual === 0n;

    // Entry rent: the ATA the buy opened, and whether the close gave it back.
    const entryCreated = createdAccountRent(b2, [taker]);
    const entryAta = entryCreated.accounts.find((a) => a.pubkey === takerAta);
    p.entryAtaRentLamports = entryAta?.rentLamports ?? '0';
    // Across the whole sequence, not per step: the shared accounts are opened
    // by the BUY and are still open after the close, so a per-step reading of
    // the sell finds nothing and charges the trade for one-time setup.
    const sequenceCreated = createdAccountRentAcross(pass2.steps, [taker, takerAta]);
    p.setupRentLamports = sequenceCreated.lamports.toString();
    p.setupAccounts = sequenceCreated.accounts.map((a) => a.pubkey);

    if (closeStep === undefined || closeStep.status !== 'SIMULATED_OK') {
      p.entryAtaRentRecovered = false;
      fail('CLOSE_FAILED_IN_RUNTIME', closeStep?.transactionError ?? 'no result');
      continue;
    }
    const before = BigInt(b2.preAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
    const afterSell = BigInt(sellStep.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
    const after = BigInt(closeStep.postAccounts.find((a) => a.pubkey === taker)?.lamports ?? 0);
    p.entryAtaRentRecovered = after > afterSell;

    /**
     * The three cases, and what separates them.
     *
     *   first wallet setup  everything this sequence had to open, including
     *                       the accounts a wallet opens exactly once ever
     *   first mint setup    the same minus the wallet-wide ones, which is what
     *                       a new mint costs a wallet that has traded before
     *   repeat trade        neither, which is the steady state
     *
     * The entry ATA is per mint AND recoverable, so it belongs to the mint case
     * and only to the extent the close failed to recover it. The sell's created
     * accounts — the coin-creator fee vault, the user volume accumulator — are
     * not recovered by anything this system does.
     */
    const netMeasured = after - before - PRIORITY_AND_TIP_LAMPORTS;
    p.firstWalletSetupNetLamports = netMeasured.toString();
    const walletWide = sequenceCreated.lamports;
    p.firstMintSetupNetLamports = (netMeasured + walletWide).toString();
    const mintWide = p.entryAtaRentRecovered === true ? 0n : rentExemptLamports(165n);
    const repeat = netMeasured + walletWide + mintWide;
    p.repeatTradeNetLamports = repeat.toString();
    p.repeatTradeDragBps = ratioBps(-repeat, notional);

    // Reconciliation. Every lamport the payer lost, against the components
    // this script can name.
    const named = quoted - notional - 15_000n - PRIORITY_AND_TIP_LAMPORTS - walletWide - mintWide;
    p.unexplainedResidualLamports = (netMeasured - named).toString();

    /**
     * Latency, at this size.
     *
     * The exit that arrives one step later sells into a pool that another
     * participant may have moved. What is measurable here without inventing a
     * counterparty is the exit that arrives after the buy has been absorbed —
     * so the same sell is priced against a state one further buy of the same
     * size has hit, and the gap is what a delay costs at this notional.
     */
    try {
      const secondBuy = await buildBuyFrom(postSrc, {
        poolKey: pool,
        user: taker,
        quoteLamports: notional,
        slippagePct: SLIPPAGE_PCT,
      });
      const secondBytes = Buffer.from(
        encodeUnsignedTransaction(
          compileMessage(secondBuy.instructions.map(toRaw), taker, '11111111111111111111111111111111', {}),
        ),
      ).toString('base64');
      const laggy = runSequential({
        jobId: `surface-${c.mint.slice(0, 8)}-${notional}-lag`,
        snapshot: {
          programs: snapshot.programs.map((x) => ({ programId: x.programId, elfBase64: x.elfBase64 })),
          accounts,
          slot: snapshot.slot,
          unixTimestamp: snapshot.unixTimestamp,
        },
        steps: [
          { label: 'buy', transactionBase64: buyBytes, observe },
          { label: 'other', transactionBase64: secondBytes, observe },
        ],
        timeoutMs: 240_000,
      });
      const other = laggy.steps[1];
      if (other !== undefined && other.status === 'SIMULATED_OK') {
        const laterSrc = overlaySource(preSrc, accountSourceOf(other.postAccounts));
        const later = quoteSellFrom(laterSrc, pool, acquired, SLIPPAGE_PCT).quoteOutLamports;
        p.exitAfterOneBlockLamports = later.toString();
        p.latencySensitivityBps = ratioBps(quoted - later, quoted);
      }
    } catch {
      /* latency is an extra reading, not a reason to lose the point */
    }

    p.evidenceClass = classifyRoundTrip({
      entryCommitted: true,
      exitCommitted: true,
      exitPricedFrom: 'COMMITTED_PRIOR_STEP',
      exitExecutedOn: 'COMMITTED_PRIOR_STEP',
      entryMutatedExitVenue: true,
    }).evidenceClass;
    p.status = 'MEASURED';
    points.push(p);
    anyPoint = true;
    console.log(
      `    ${String(notional).padStart(9)}  drag ${p.ammDragBps}bps  repeat ${p.repeatTradeDragBps}bps  ` +
        `pos/reserve ${p.positionOverBaseReserveBps}bps  latency ${p.latencySensitivityBps}bps`,
    );
  }
  if (anyPoint) mintsDone.push(c.mint);
}

/**
 * The prospective choice.
 *
 * Smallest notional whose repeat-trade drag clears the mechanics gate on the
 * MEDIAN mint, breaking ties by capital at risk — which is the notional itself.
 * Nothing here reads a return, and nothing here is chosen because it performed.
 */
const measured = points.filter((x) => x.status === 'MEASURED');
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
}
const bySize = GRID.map((size) => {
  const at = measured.filter((x) => x.notionalLamports === size.toString());
  return {
    notionalLamports: size.toString(),
    points: at.length,
    fullExitPossible: at.filter((x) => x.fullExitPossible === true).length,
    medianAmmDragBps: median(at.map((x) => x.ammDragBps).filter((n): n is number => n !== null)),
    medianRepeatTradeDragBps: median(at.map((x) => x.repeatTradeDragBps).filter((n): n is number => n !== null)),
    medianFirstMintSetupNetLamports: median(
      at.map((x) => (x.firstMintSetupNetLamports === null ? null : Number(x.firstMintSetupNetLamports))).filter(
        (n): n is number => n !== null,
      ),
    ),
    medianPositionOverBaseReserveBps: median(
      at.map((x) => x.positionOverBaseReserveBps).filter((n): n is number => n !== null),
    ),
    medianUnexplainedResidualLamports: median(
      at.map((x) => (x.unexplainedResidualLamports === null ? null : Number(x.unexplainedResidualLamports))).filter(
        (n): n is number => n !== null,
      ),
    ),
    medianLatencySensitivityBps: median(
      at.map((x) => x.latencySensitivityBps).filter((n): n is number => n !== null),
    ),
  };
});

/** The gate: a repeat trade must not lose more than this to mechanics alone. */
const MECHANICS_GATE_BPS = 300;
const clearing = bySize.filter(
  (r) => r.points > 0 && r.medianRepeatTradeDragBps !== null && r.medianRepeatTradeDragBps <= MECHANICS_GATE_BPS,
);
const chosen = clearing[0] ?? null;

const summary = {
  provenance: currentProvenance({
    strategyVersion: 'delayed-momentum-v0.6.0',
    schemaVersion: 'schema-v31',
    sampleInclusionQuery: 'execution_observations buys, last 7d, canonical PumpSwap pool present',
  }),
  grid: GRID.map(String),
  slippagePct: SLIPPAGE_PCT,
  priorityAndTipLamports: PRIORITY_AND_TIP_LAMPORTS.toString(),
  mechanicsGateBps: MECHANICS_GATE_BPS,
  mints: mintsDone.length,
  measured: measured.length,
  attempted: points.length,
  bySize,
  developmentNotionalLamports: chosen?.notionalLamports ?? null,
  developmentNotionalReason:
    chosen === null
      ? `no notional in the grid clears a ${MECHANICS_GATE_BPS} bps mechanics gate on the median mint`
      : `smallest grid notional whose median repeat-trade drag (${chosen.medianRepeatTradeDragBps} bps) clears ${MECHANICS_GATE_BPS} bps`,
  points,
  note:
    'Every point is a buy, a sell and a close that committed in ONE runtime state, with the sell priced ' +
    'and built from the buy-mutated pool. Raw atom counts appear only as inputs to dimensionless ratios; ' +
    'they move with decimals, supply and price and are not portable across tokens.',
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/true-stateful-size-surface.json', JSON.stringify(summary, null, 2));

console.log('\nsize      points  fullExit  ammDrag  repeatDrag  pos/reserve  latency');
for (const r of bySize) {
  console.log(
    `${r.notionalLamports.padStart(9)}  ${String(r.points).padStart(6)}  ${String(r.fullExitPossible).padStart(8)}  ` +
      `${String(r.medianAmmDragBps).padStart(7)}  ${String(r.medianRepeatTradeDragBps).padStart(10)}  ` +
      `${String(r.medianPositionOverBaseReserveBps).padStart(11)}  ${String(r.medianLatencySensitivityBps).padStart(7)}`,
  );
}
console.log(`\ndevelopment notional: ${summary.developmentNotionalLamports ?? 'NONE'}`);
console.log(summary.developmentNotionalReason);
console.log('artifacts/true-stateful-size-surface.json');
db.close();
