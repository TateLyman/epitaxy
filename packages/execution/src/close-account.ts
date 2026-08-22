import { base58Decode } from '../../solana/src/base58.js';
import { COMPUTE_BUDGET_PROGRAM } from '../../solana/src/transaction.js';
import type { DecodedTransaction } from '../../solana/src/transaction.js';
import type { TradeIntent, Base58 } from '../../domain/src/types.js';
import type { EffectVerdict } from './effect.js';
import type { ExecutionRpc } from './rpc.js';

/**
 * Recovering the rent stranded in an emptied token account.
 *
 * WHY THIS EXISTS AT ALL. An associated token account costs 2,039,280 lamports of rent to open.
 * On a 0.02 SOL position that is 1,020 basis points — FOURTEEN TIMES the entire measured AMM fee
 * of 71 bps (MT132). The rent is fully refundable when the account is closed, so it is not a cost
 * at all unless the account is abandoned. Nothing in this executor closed one, so it was a cost.
 *
 * `doctor --mode=canary` catches this as `config.viableCapital`: with `assumedRentRecoveryRate`
 * at 0.5 the fee-viability floor is 20,912,800 lamports, above the largest position the sizing
 * rule permits, so no trade can ever open. Ninety-seven percent of that floor is stranded rent.
 * Closing the account is what makes a small position arithmetically possible.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a general transaction builder. It emits exactly two
 * instructions — a compute-unit limit, which the transaction policy requires, and one SPL Token
 * `CloseAccount` — and it cannot express anything else. There is no amount to get wrong: the
 * instruction has a one-byte body and moves the account's entire rent to a destination this
 * module always sets to the owner itself.
 *
 * IT STILL GOES THROUGH THE SIGNER'S ONE ENTRY POINT. Policy, binding and effect all run
 * unchanged. Binding's lamport-outflow bound passes trivially because a close performs no System
 * transfer, which is a property of the instruction rather than something asserted here.
 */

/** SPL Token instruction 9. One byte, no arguments. */
const CLOSE_ACCOUNT_TAG = 9;
/** ComputeBudget instruction 2: SetComputeUnitLimit(u32). */
const SET_COMPUTE_UNIT_LIMIT_TAG = 2;
/** A close costs a few thousand units; this is deliberate slack, not a measurement. */
const CLOSE_COMPUTE_UNITS = 20_000;
const SIGNATURE_BYTES = 64;
const PUBKEY_BYTES = 32;

export class CloseBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloseBuildError';
  }
}

/** compact-u16, the length prefix Solana uses for every vector in a message. */
function shortvec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>>= 7;
    if (v === 0) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return out;
}

function key(pubkey: string): Uint8Array {
  const raw = base58Decode(pubkey, 64);
  if (raw.length !== PUBKEY_BYTES) throw new CloseBuildError(`${pubkey} is ${raw.length} bytes, not 32`);
  return raw;
}

/**
 * A legacy transaction with an empty signature slot, ready for the signer.
 *
 * Account order is the layout the runtime requires: writable signers, readonly signers, writable
 * non-signers, readonly non-signers. Index 0 is the fee payer by definition, which is also what
 * binding relies on when it decides whose lamports are leaving.
 */
export function encodeCloseAccountTransaction(params: {
  readonly owner: string;
  readonly tokenAccount: string;
  readonly tokenProgram: string;
  readonly recentBlockhash: string;
}): Uint8Array {
  const { owner, tokenAccount, tokenProgram, recentBlockhash } = params;
  if (owner === tokenAccount) throw new CloseBuildError('owner and token account must differ');

  //  0 owner          signer, writable  (fee payer, and the rent destination)
  //  1 tokenAccount   writable          (the account being closed)
  //  2 ComputeBudget  readonly
  //  3 tokenProgram   readonly
  const keys = [owner, tokenAccount, COMPUTE_BUDGET_PROGRAM, tokenProgram];
  const msg: number[] = [];
  msg.push(1);            // numRequiredSignatures
  msg.push(0);            // numReadonlySignedAccounts
  msg.push(2);            // numReadonlyUnsignedAccounts — the two programs
  msg.push(...shortvec(keys.length));
  for (const k of keys) msg.push(...key(k));
  msg.push(...key(recentBlockhash));

  const units = new Uint8Array(4);
  new DataView(units.buffer).setUint32(0, CLOSE_COMPUTE_UNITS, true);

  const ixs: number[][] = [
    // ComputeBudget SetComputeUnitLimit — the policy refuses a transaction without one.
    [2, ...shortvec(0), ...shortvec(5), SET_COMPUTE_UNIT_LIMIT_TAG, ...units],
    // CloseAccount: [account to close, rent destination, owner authority].
    // Destination is index 0, the owner, so the rent cannot be routed anywhere else.
    [3, ...shortvec(3), 1, 0, 0, ...shortvec(1), CLOSE_ACCOUNT_TAG],
  ];
  msg.push(...shortvec(ixs.length));
  for (const ix of ixs) msg.push(...ix);

  const tx: number[] = [...shortvec(1), ...new Array<number>(SIGNATURE_BYTES).fill(0), ...msg];
  return new Uint8Array(tx);
}

/**
 * An intent describing a close: no input, no output, no lamports leaving.
 *
 * The signer takes an intent because bytes alone are a remote-code-execution primitive pointed at
 * the wallet. A close has no amounts, so every bound here is zero — which is exactly what makes
 * it checkable: binding will refuse anything that moves lamports out, and a close moves them IN.
 */
export function closeAccountIntent(params: {
  readonly mint: Base58;
  readonly nowUtcMs: number;
  readonly maxTotalFeeLamports: bigint;
  readonly strategyVersion: string;
  readonly riskSnapshotHash: string;
  readonly ttlMs?: number;
}): TradeIntent {
  const { mint, nowUtcMs, maxTotalFeeLamports, strategyVersion, riskSnapshotHash } = params;
  const id = `close-${mint}-${String(nowUtcMs)}`;
  return {
    intentId: id,
    idempotencyKey: id,
    mint,
    side: 'sell',
    inputMint: mint,
    outputMint: mint,
    maxInputAmount: 0n,
    minOutputAmount: 0n,
    maxTotalFeeLamports,
    maxPriorityFeeLamports: 0n,
    deadlineUtcMs: nowUtcMs + (params.ttlMs ?? 30_000),
    strategyVersion,
    riskSnapshotHash,
    createdUtcMs: nowUtcMs,
  };
}

const SPL_AMOUNT_OFFSET = 64;
const SPL_MIN_LEN = 72;

function tokenAmount(account: { dataBase64: string } | null): bigint | null {
  if (account === null) return null;
  const raw = Buffer.from(account.dataBase64, 'base64');
  if (raw.length < SPL_MIN_LEN) return null;
  return raw.readBigUInt64LE(SPL_AMOUNT_OFFSET);
}

/**
 * Establishes what the close will actually do, by running it.
 *
 * The general `verifyEffect` is built around a swap and asks about output mints and minimum
 * amounts, none of which a close has. This asks the three questions a close does have, and
 * refuses on anything it cannot observe:
 *   - the token account must end at zero lamports, i.e. actually closed
 *   - the owner's lamports must RISE, because rent is coming back
 *   - the token balance being discarded must be zero, so no position is thrown away
 */
export async function verifyCloseEffect(
  rpc: ExecutionRpc,
  rawBase64: string,
  decoded: DecodedTransaction,
  tokenAccount: string,
  owner: string,
): Promise<EffectVerdict> {
  const addresses = [...decoded.staticAccountKeys];
  const iAta = addresses.indexOf(tokenAccount);
  const iOwner = addresses.indexOf(owner);
  if (iAta < 0 || iOwner < 0) {
    return {
      verified: false,
      refusals: [{ refusal: 'output_account_not_found', detail: 'token account or owner absent from static keys' }],
      lamportDelta: null, outputDelta: null, inputDelta: null, logs: [], unitsConsumed: null,
    };
  }

  let pre: ({ lamports: bigint; owner: string; dataBase64: string } | null)[];
  let sim;
  try {
    pre = await rpc.getAccounts(addresses);
    sim = await rpc.simulate(rawBase64, addresses);
  } catch (e) {
    return {
      verified: false,
      refusals: [{ refusal: 'simulation_unavailable', detail: (e as Error).message }],
      lamportDelta: null, outputDelta: null, inputDelta: null, logs: [], unitsConsumed: null,
    };
  }
  if (sim.err !== null) {
    return {
      verified: false,
      refusals: [{ refusal: 'simulation_failed', detail: JSON.stringify(sim.err).slice(0, 200) }],
      lamportDelta: null, outputDelta: null, inputDelta: null, logs: sim.logs, unitsConsumed: sim.unitsConsumed,
    };
  }

  const preAta = pre[iAta] ?? null;
  const postAta = sim.accounts[iAta] ?? null;
  const preOwner = pre[iOwner] ?? null;
  const postOwner = sim.accounts[iOwner] ?? null;
  if (preAta === null || preOwner === null || postOwner === null) {
    return {
      verified: false,
      refusals: [{ refusal: 'simulation_unavailable', detail: 'pre or post state missing for owner or token account' }],
      lamportDelta: null, outputDelta: null, inputDelta: null, logs: sim.logs, unitsConsumed: sim.unitsConsumed,
    };
  }

  const refusals: { refusal: EffectVerdict['refusals'][number]['refusal']; detail: string }[] = [];
  const held = tokenAmount(preAta);
  if (held === null) {
    refusals.push({ refusal: 'unexpected_mint_movement', detail: 'pre-state is not a readable SPL token account' });
  } else if (held !== 0n) {
    // Closing a non-empty account is refused by the program, but refusing it HERE means we never
    // ask the network to throw away a position.
    refusals.push({ refusal: 'input_above_maximum', detail: `token account still holds ${held.toString()} units` });
  }
  const postAtaLamports = postAta === null ? 0n : postAta.lamports;
  if (postAtaLamports !== 0n) {
    refusals.push({ refusal: 'output_below_minimum', detail: `token account retains ${postAtaLamports.toString()} lamports` });
  }
  const lamportDelta = postOwner.lamports - preOwner.lamports;
  if (lamportDelta <= 0n) {
    refusals.push({ refusal: 'output_below_minimum', detail: `owner lamports moved ${lamportDelta.toString()}, expected a rent refund` });
  }

  return {
    verified: refusals.length === 0,
    refusals,
    lamportDelta,
    outputDelta: lamportDelta,
    inputDelta: held,
    logs: sim.logs,
    unitsConsumed: sim.unitsConsumed,
  };
}

/**
 * THE TOKEN ACCOUNT ADDRESS IS LOOKED UP, NEVER DERIVED, and that is a safety decision.
 *
 * A first version derived the associated token address itself. Deriving a program address
 * correctly requires rejecting candidates that land ON the ed25519 curve, and Node's
 * `createPublicKey` accepts almost any 32 bytes as an ed25519 SPKI — so the curve test silently
 * returned true for every bump and the derivation found nothing. The unit test caught it.
 *
 * A wrong address here is not a small bug. It is a signed instruction pointed at an account we
 * did not mean to touch. `getTokenAccountsByOwner` returns the real accounts this wallet actually
 * owns, which is both authoritative and impossible to get subtly wrong, so callers pass an
 * address the chain gave them rather than one we computed.
 */
export interface OwnedTokenAccount {
  readonly address: string;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly amount: bigint;
  readonly lamports: bigint;
}
