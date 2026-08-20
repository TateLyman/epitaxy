/**
 * `pnpm watchlist:sweep` — run the MT101 source and measure what it delivers.
 *
 * THIS DOES NOT TRADE, AND IT DOES NOT OPEN A TRAJECTORY. It sweeps the frozen
 * watchlist, stores every observed action, applies the frozen trigger, and
 * stores every decision including every refusal. Nothing here can take a
 * position: it imports no execution code and writes to no capital-bearing table.
 *
 * WHY THIS EXISTS BEFORE THE TRAJECTORY WIRING
 *
 * MT101's largest unknown is not the return. It is the ADMITTED-SIGNAL RATE,
 * which the ledger row states is a reported quantity of the experiment and not
 * an input to it, and which carries one of the five kill conditions: under five
 * a day sustained is operational irrelevance rather than a return failure. The
 * Q13 export projects roughly 43 PumpSwap buys a day across the 128 wallets,
 * from a fit-window venue share applied to a holdout position count — which is
 * an estimate resting on two approximations, and the collector can simply
 * measure it instead.
 *
 * Measuring it first is also the cheap order. If the rate is far below the
 * projection, the arm is killed on a fact that costs a day of observation
 * rather than after the trajectory integration is built around it.
 *
 * THE ENDPOINT IS NOT A DETAIL. `pnpm provider:probe` measured
 * getSignaturesForAddress at 20/20 on the primary endpoint and 0/20 on Helius
 * free, which is the reverse of the note that was in config/source-limits.json.
 * This runs against the primary, and it shares the 8 req/s endpoint-wide budget
 * with anything else running, which is why the sweep is budgeted rather than
 * greedy.
 */
import { openDb } from '../packages/storage/src/db.js';
import { loadSecrets } from '../packages/domain/src/config.js';
import { researchRpc } from '../packages/solana/src/endpoint.js';
import { canonicalPool } from '../packages/solana/src/pumpswap-offline.js';
import { RpcError } from '../packages/solana/src/rpc.js';
import {
  MT101,
  evaluateSignal,
  freezeWatchlist,
  sweepBudget,
  type FlaggedWallet,
  type SignalDecision,
  type WalletFlowEvent,
} from '../packages/intelligence/src/wallet-watchlist.js';
import { PollingWalletFlowSource } from '../packages/intelligence/src/wallet-flow-source.js';

const once = process.argv.includes('--once');
const sweeps = Number(process.argv.find((a) => a.startsWith('--sweeps='))?.split('=')[1] ?? '0');

const db = openDb({ path: 'data/runtime.db' });

const rows = db
  .prepare(
    `SELECT address, rank_position, rank_stat, fit_positions
       FROM flagged_wallets WHERE ledger_row = ? ORDER BY rank_position`,
  )
  .all(MT101.ledgerRow) as { address: string; rank_position: number; rank_stat: number; fit_positions: number }[];

if (rows.length === 0) {
  console.error(`no wallets frozen under ${MT101.ledgerRow}. Run pnpm watchlist:load first.`);
  process.exit(1);
}

const watchlist = freezeWatchlist(
  rows.map(
    (r): FlaggedWallet => ({
      address: r.address,
      rankPosition: r.rank_position,
      rankStat: r.rank_stat,
      fitPositions: r.fit_positions,
    }),
  ),
);

const secrets = loadSecrets();
const { rpc, host, participatingInSharedBudget } = researchRpc(secrets, db);
const budget = sweepBudget(watchlist.size);

console.log(`MT101 watchlist sweep — OBSERVATION ONLY, nothing is opened and nothing is signed`);
console.log(`  wallets ${watchlist.size}  interval ${MT101.sweepIntervalMs}ms  endpoint ${host}`);
console.log(`  budget: ${budget.signatureCalls} signature calls + ${budget.decodeHeadroom} decodes per sweep`);
console.log(`  shared endpoint budget: ${participatingInSharedBudget ? 'participating' : 'NOT PARTICIPATING'}`);
console.log('');

const source = new PollingWalletFlowSource(rpc, watchlist);

const insertEvent = db.prepare(
  `INSERT OR IGNORE INTO wallet_flow_events
     (signature, instruction_index, wallet, mint, side, quote_lamports, program_id, slot,
      block_utc_ms, observed_utc_ms, detection_lag_ms, source, commitment, tx_error, decode_refusal)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertSignal = db.prepare(
  `INSERT OR IGNORE INTO wallet_signals
     (signal_id, mint, trigger_signature, trigger_instruction, wallet, wallet_rank, k_observed,
      block_utc_ms, observed_utc_ms, evaluated_utc_ms, signal_age_ms, age_basis, outcome, refusal,
      selection_arm, ledger_row, contract_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

function persistEvent(e: WalletFlowEvent): void {
  insertEvent.run(
    e.signature,
    e.instructionIndex,
    e.wallet,
    e.mint,
    e.side,
    // TEXT, because SQLite INTEGER is 64-bit SIGNED and this is a token amount.
    e.quoteLamports === null ? null : e.quoteLamports.toString(),
    e.programId,
    e.slot,
    e.blockUtcMs,
    e.observedUtcMs,
    e.detectionLagMs,
    e.source,
    e.commitment,
    e.txError ? 1 : 0,
    e.decodeRefusal,
  );
}

/**
 * Does a canonical PumpSwap pool exist for this mint?
 *
 * Three states, and the third is the one that matters. `account_missing` is a
 * fact about the venue and returns false. ANY OTHER failure returns null, which
 * the trigger treats as a refusal — an unread account is not an absent pool,
 * and letting a provider hiccup read as "no pool" would turn our own outage
 * into a venue statistic.
 */
async function poolPresent(mint: string): Promise<boolean | null> {
  let pool: string;
  try {
    pool = canonicalPool(mint);
  } catch {
    return false;
  }
  try {
    await rpc.getAccountRaw(pool);
    return true;
  } catch (e) {
    if (e instanceof RpcError && e.kind === 'account_missing') return false;
    return null;
  }
}

const totals = { sweeps: 0, events: 0, decoded: 0, deferred: 0, unreadable: 0 };
const outcomes = new Map<string, number>();
const signalledMints = new Set<string>(
  (db.prepare('SELECT DISTINCT mint FROM wallet_signals WHERE ledger_row = ? AND outcome = ?').all(
    MT101.ledgerRow,
    'FORWARDED',
  ) as { mint: string }[]).map((r) => r.mint),
);

const startedAt = Date.now();

async function oneSweep(): Promise<void> {
  const now = Date.now();
  const result = await source.sweep(now);
  totals.sweeps += 1;
  totals.events += result.events.length;
  totals.decoded += result.decodeCalls;
  totals.deferred += result.deferred;
  totals.unreadable += result.unreadableWallets.length;

  const decisions: { e: WalletFlowEvent; d: SignalDecision }[] = [];
  for (const e of result.events) {
    persistEvent(e);
    // Pool presence is only read for events that could still become a signal,
    // so an unrelated transfer never costs an account read.
    if (e.decodeRefusal !== null || e.side !== 'BUY') {
      const d = evaluateSignal(e, {
        watchlist,
        evaluatedUtcMs: Date.now(),
        alreadySignalledMints: signalledMints,
        poolPresent: false,
      });
      if (d !== null) decisions.push({ e, d });
      continue;
    }
    const present = await poolPresent(e.mint as string);
    const d = evaluateSignal(e, {
      watchlist,
      evaluatedUtcMs: Date.now(),
      alreadySignalledMints: signalledMints,
      poolPresent: present,
    });
    if (d !== null) decisions.push({ e, d });
  }

  for (const { e, d } of decisions) {
    outcomes.set(d.outcome, (outcomes.get(d.outcome) ?? 0) + 1);
    insertSignal.run(
      `${e.signature}:${e.instructionIndex}`,
      d.mint,
      e.signature,
      e.instructionIndex,
      d.wallet,
      d.walletRank,
      d.kObserved,
      e.blockUtcMs,
      e.observedUtcMs,
      Date.now(),
      d.signalAgeMs,
      d.ageBasis,
      d.outcome,
      d.refusal,
      MT101.selectionArm,
      MT101.ledgerRow,
      null,
    );
    if (d.outcome === 'FORWARDED') signalledMints.add(d.mint);
  }

  const hours = (Date.now() - startedAt) / 3_600_000;
  const fwd = outcomes.get('FORWARDED') ?? 0;
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(
    `${stamp}  sweep ${totals.sweeps}  events ${result.events.length}  decodes ${result.decodeCalls}` +
      `  deferred ${result.deferred}  unreadable ${result.unreadableWallets.length}` +
      `  seeded ${source.seeded()}/${watchlist.size}`,
  );
  if (decisions.length > 0) {
    const summary = [...outcomes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  ');
    console.log(`          ${summary}`);
    if (hours > 0.02) console.log(`          FORWARDED rate: ${(fwd / hours).toFixed(2)}/hour = ${(fwd / hours * 24).toFixed(1)}/day`);
  }
}

const limit = once ? 1 : sweeps > 0 ? sweeps : Number.POSITIVE_INFINITY;
let n = 0;
while (n < limit) {
  await oneSweep();
  n += 1;
  if (n < limit) await new Promise((r) => setTimeout(r, MT101.sweepIntervalMs));
}

console.log('');
console.log(`totals: ${JSON.stringify(totals)}`);
console.log(`outcomes: ${JSON.stringify(Object.fromEntries(outcomes))}`);
db.close();
