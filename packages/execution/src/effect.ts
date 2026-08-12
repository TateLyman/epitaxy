import { base58Encode } from '../../solana/src/base58.js';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../../solana/src/mint.js';
import type { DecodedTransaction } from '../../solana/src/transaction.js';
import type { TradeIntent } from '../../domain/src/types.js';
import type { ExecutionRpc } from './rpc.js';

/**
 * Establishing what a transaction will actually do, by running it.
 *
 * The swap amounts are encoded inside an aggregator instruction whose layout we
 * do not own. Reading them would mean hardcoding a discriminator and a field
 * order that could change without notice, producing a check that looks like it
 * bounds the trade and does not. Balances do not have that problem: whatever
 * the instruction data says, the account state after execution is the effect.
 *
 * So the bound is measured, not parsed. Simulate against current state, diff
 * the accounts, and compare the diff to the intent. If simulation is
 * unavailable the answer is "unverified", and the signer treats unverified as
 * a refusal rather than as an absent objection.
 */

const SPL_MINT_OFFSET = 0;
const SPL_OWNER_OFFSET = 32;
const SPL_AMOUNT_OFFSET = 64;
const SPL_MIN_LEN = 72;

interface TokenAccountView {
  readonly mint: string;
  readonly owner: string;
  readonly amount: bigint;
}

function readTokenAccount(
  account: { owner: string; dataBase64: string } | null,
): TokenAccountView | null {
  if (account === null) return null;
  if (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM) return null;
  const data = Buffer.from(account.dataBase64, 'base64');
  if (data.length < SPL_MIN_LEN) return null;
  let amount = 0n;
  for (let i = 7; i >= 0; i--) amount = (amount << 8n) | BigInt(data[SPL_AMOUNT_OFFSET + i] as number);
  return {
    mint: base58Encode(new Uint8Array(data.subarray(SPL_MINT_OFFSET, SPL_MINT_OFFSET + 32))),
    owner: base58Encode(new Uint8Array(data.subarray(SPL_OWNER_OFFSET, SPL_OWNER_OFFSET + 32))),
    amount,
  };
}

export type EffectRefusal =
  | 'simulation_failed'
  | 'simulation_unavailable'
  | 'output_account_not_found'
  | 'output_below_minimum'
  | 'input_above_maximum'
  | 'unexpected_mint_movement';

export interface EffectVerdict {
  readonly verified: boolean;
  readonly refusals: readonly { refusal: EffectRefusal; detail: string }[];
  /** Lamports the fee payer loses, including fees and any rent it funds. */
  readonly lamportDelta: bigint | null;
  /** Change in our balance of the intent's output mint. */
  readonly outputDelta: bigint | null;
  readonly inputDelta: bigint | null;
  readonly logs: readonly string[];
  readonly unitsConsumed: number | null;
}

function fail(refusal: EffectRefusal, detail: string, partial: Partial<EffectVerdict> = {}): EffectVerdict {
  return {
    verified: false,
    refusals: [{ refusal, detail }],
    lamportDelta: partial.lamportDelta ?? null,
    outputDelta: partial.outputDelta ?? null,
    inputDelta: partial.inputDelta ?? null,
    logs: partial.logs ?? [],
    unitsConsumed: partial.unitsConsumed ?? null,
  };
}

/**
 * Verifies a candidate transaction against the intent by simulating it.
 *
 * Only static account keys are inspected. An account reachable solely through
 * an address lookup table cannot be resolved without fetching the table, and a
 * balance we did not measure is not evidence — if the destination token account
 * is not among the static keys, the result is `output_account_not_found` and
 * the trade does not happen. Refusing is cheap; signing a transaction whose
 * output we could not observe is not.
 */
export async function verifyEffect(
  rpc: ExecutionRpc,
  rawBase64: string,
  decoded: DecodedTransaction,
  intent: TradeIntent,
  signerPubkey: string,
): Promise<EffectVerdict> {
  const addresses = [...decoded.staticAccountKeys];

  let pre: ({ lamports: bigint; owner: string; dataBase64: string } | null)[];
  let sim: Awaited<ReturnType<ExecutionRpc['simulate']>>;
  try {
    [pre, sim] = await Promise.all([rpc.getAccounts(addresses), rpc.simulate(rawBase64, addresses)]);
  } catch (e) {
    return fail('simulation_unavailable', (e as Error).message);
  }

  if (sim.err !== null) {
    return fail('simulation_failed', JSON.stringify(sim.err).slice(0, 300), {
      logs: sim.logs,
      unitsConsumed: sim.unitsConsumed,
    });
  }
  if (sim.accounts.length !== addresses.length) {
    return fail(
      'simulation_unavailable',
      `simulation returned ${sim.accounts.length} accounts for ${addresses.length} requested`,
      { logs: sim.logs },
    );
  }

  const payerIndex = addresses.indexOf(signerPubkey);
  const lamportDelta =
    payerIndex >= 0
      ? (pre[payerIndex]?.lamports ?? 0n) - (sim.accounts[payerIndex]?.lamports ?? 0n)
      : null;

  // Our token balances by mint, before and after, summed across every account
  // of ours that the transaction touches. Summing matters: a route may move
  // through more than one account for the same mint, and looking at only the
  // first would understate what left.
  const before = new Map<string, bigint>();
  const after = new Map<string, bigint>();
  const seenMints = new Set<string>();
  for (let i = 0; i < addresses.length; i++) {
    const a = readTokenAccount(pre[i] ?? null);
    const b = readTokenAccount(sim.accounts[i] ?? null);
    const view = b ?? a;
    if (view === null || view.owner !== signerPubkey) continue;
    seenMints.add(view.mint);
    const wasOurs = a !== null && a.owner === signerPubkey ? a.amount : 0n;
    const isOurs = b !== null && b.owner === signerPubkey ? b.amount : 0n;
    before.set(view.mint, (before.get(view.mint) ?? 0n) + wasOurs);
    after.set(view.mint, (after.get(view.mint) ?? 0n) + isOurs);
  }

  const refusals: { refusal: EffectRefusal; detail: string }[] = [];

  const outputDelta = seenMints.has(intent.outputMint)
    ? (after.get(intent.outputMint) ?? 0n) - (before.get(intent.outputMint) ?? 0n)
    : null;
  const inputDelta = seenMints.has(intent.inputMint)
    ? (before.get(intent.inputMint) ?? 0n) - (after.get(intent.inputMint) ?? 0n)
    : null;

  // SOL is held natively, not as a token account, so a SOL-side leg is measured
  // by the lamport delta instead.
  const outputIsSol = intent.outputMint === WRAPPED_SOL;
  const inputIsSol = intent.inputMint === WRAPPED_SOL;

  const effectiveOutput = outputIsSol ? (lamportDelta === null ? null : -lamportDelta) : outputDelta;
  const effectiveInput = inputIsSol ? lamportDelta : inputDelta;

  if (effectiveOutput === null) {
    refusals.push({
      refusal: 'output_account_not_found',
      detail: `no observable balance for output mint ${intent.outputMint} among static accounts`,
    });
  } else if (effectiveOutput < intent.minOutputAmount) {
    refusals.push({
      refusal: 'output_below_minimum',
      detail: `${effectiveOutput} < ${intent.minOutputAmount}`,
    });
  }

  if (effectiveInput === null) {
    refusals.push({
      refusal: 'output_account_not_found',
      detail: `no observable balance for input mint ${intent.inputMint} among static accounts`,
    });
  } else if (effectiveInput > intent.maxInputAmount + (inputIsSol ? intent.maxTotalFeeLamports : 0n)) {
    refusals.push({
      refusal: 'input_above_maximum',
      detail: `${effectiveInput} > ${intent.maxInputAmount}${inputIsSol ? ` + ${intent.maxTotalFeeLamports} fees` : ''}`,
    });
  }

  // A third mint whose balance moves is a leg nobody asked for. Wrapped SOL is
  // exempt because routing through it is how a SOL leg is executed at all.
  for (const mint of seenMints) {
    if (mint === intent.inputMint || mint === intent.outputMint || mint === WRAPPED_SOL) continue;
    const delta = (after.get(mint) ?? 0n) - (before.get(mint) ?? 0n);
    if (delta !== 0n) {
      refusals.push({ refusal: 'unexpected_mint_movement', detail: `${mint} moved by ${delta}` });
    }
  }

  return {
    verified: refusals.length === 0,
    refusals,
    lamportDelta,
    outputDelta: effectiveOutput,
    inputDelta: effectiveInput,
    logs: sim.logs,
    unitsConsumed: sim.unitsConsumed,
  };
}

export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
