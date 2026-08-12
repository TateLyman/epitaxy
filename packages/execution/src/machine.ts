import { createHash } from 'node:crypto';
import type { Db } from '../../storage/src/db.js';
import {
  newId,
  claimIntent,
  setIntentState,
  recordAttempt,
  updateAttempt,
  unresolvedAttempts,
  attemptCount,
  recordSignRefusal,
  recordHealth,
  type AttemptRow,
} from '../../storage/src/repo.js';
import { decodeTransaction, TxDecodeError } from '../../solana/src/transaction.js';
import type { TradeIntent } from '../../domain/src/types.js';
import type { RateLimiter } from '../../adapters/src/ratelimit.js';
import { ExecutionRpc } from './rpc.js';
import { Signer } from './signer.js';
import { verifyEffect } from './effect.js';
import { buildSignableOrder, OrderBuildError } from './order.js';

/**
 * The execution state machine.
 *
 * The problem it exists to solve is not "how do we send a transaction". It is
 * "what do we believe after a send whose response we never saw". A send that
 * times out has three possible truths — never broadcast, broadcast and landed,
 * broadcast and failed — and only one of them is safe to retry. So the
 * signature is written to durable storage BEFORE the send, and any attempt
 * whose fate is unknown blocks all further execution until it is resolved
 * against the chain.
 *
 * The alternative, retrying on error, buys the same token twice with the same
 * money about as often as the network hiccups.
 */

export interface ExecutorDeps {
  readonly db: Db;
  readonly rpc: ExecutionRpc;
  readonly signer: Signer;
  readonly limiter: RateLimiter;
  readonly jupiterApiKey: string | null;
  readonly slippageBps: number;
  readonly maxAttemptsPerIntent: number;
  readonly confirmTimeoutMs: number;
  readonly log: (event: Record<string, unknown>) => void;
}

export type ExecutionResult =
  | { readonly status: 'confirmed'; readonly signature: string; readonly slot: number; readonly attemptId: string }
  | { readonly status: 'failed'; readonly signature: string; readonly detail: string }
  | { readonly status: 'refused'; readonly kind: string; readonly detail: string }
  | { readonly status: 'duplicate'; readonly intentId: string }
  | { readonly status: 'unknown'; readonly signature: string; readonly detail: string };

/** Stable key so the same decision, replayed after a crash, is one intent. */
export function idempotencyKey(parts: {
  mint: string;
  side: 'buy' | 'sell';
  strategyVersion: string;
  amount: bigint;
  epochMs: number;
}): string {
  return createHash('sha256')
    .update(`${parts.strategyVersion}|${parts.mint}|${parts.side}|${parts.amount}|${parts.epochMs}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Resolves every attempt whose outcome is not yet known against the chain.
 *
 * Returns the number still unresolved. A non-zero return is a hard stop: the
 * wallet may hold a position nobody has recorded, and sizing the next trade
 * against a balance we do not understand is how a small failure compounds.
 */
export async function resolveOutstanding(deps: ExecutorDeps): Promise<number> {
  const outstanding = unresolvedAttempts(deps.db);
  if (outstanding.length === 0) return 0;

  let height: number | null = null;
  try {
    height = await deps.rpc.getBlockHeight();
  } catch {
    // Without a height we cannot prove expiry, so nothing gets marked expired
    // this pass. Unresolved is the correct answer when the chain is unreachable.
  }

  let stillUnresolved = 0;
  for (const a of outstanding) {
    const resolved = await resolveOne(deps, a, height);
    if (!resolved) stillUnresolved++;
  }
  return stillUnresolved;
}

async function resolveOne(deps: ExecutorDeps, a: AttemptRow, blockHeight: number | null): Promise<boolean> {
  let status: Awaited<ReturnType<ExecutionRpc['getSignatureStatus']>>;
  try {
    status = await deps.rpc.getSignatureStatus(a.signature);
  } catch (e) {
    deps.log({ event: 'resolve.rpc_failed', signature: a.signature, error: (e as Error).message });
    return false;
  }

  const now = Date.now();
  if (status !== null) {
    const failed = status.err !== null;
    updateAttempt(deps.db, a.attempt_id, {
      outcome: failed ? 'FAILED' : 'CONFIRMED',
      landedSlot: status.slot,
      chainError: failed ? JSON.stringify(status.err).slice(0, 500) : null,
      resolvedUtcMs: now,
    });
    setIntentState(deps.db, a.intent_id, failed ? 'FAILED' : 'CONFIRMED');
    deps.log({
      event: failed ? 'attempt.failed' : 'attempt.confirmed',
      signature: a.signature,
      slot: status.slot,
    });
    return true;
  }

  // No status. That is only evidence of absence once the blockhash can no
  // longer be accepted by any leader; before that, it means "not yet".
  if (blockHeight !== null && blockHeight > a.last_valid_height) {
    updateAttempt(deps.db, a.attempt_id, { outcome: 'EXPIRED', resolvedUtcMs: now });
    setIntentState(deps.db, a.intent_id, 'EXPIRED');
    deps.log({ event: 'attempt.expired', signature: a.signature, lastValidHeight: a.last_valid_height });
    return true;
  }

  if (a.outcome !== 'UNKNOWN') {
    updateAttempt(deps.db, a.attempt_id, { outcome: 'UNKNOWN' });
    setIntentState(deps.db, a.intent_id, 'UNKNOWN');
  }
  return false;
}

/**
 * Runs one intent to a terminal state.
 *
 * Refuses rather than throws wherever the refusal is a decision rather than a
 * defect, so the caller can record why a trade did not happen. A trade that
 * silently did not happen is the same missing row as a trade that was never
 * considered.
 */
export async function executeIntent(deps: ExecutorDeps, intent: TradeIntent): Promise<ExecutionResult> {
  const claim = claimIntent(deps.db, intent, false);
  if (!claim.created) {
    // Some earlier run already owns this decision. Whatever state it reached is
    // authoritative; re-deriving it here would be a second opinion about money
    // that has possibly already moved.
    return { status: 'duplicate', intentId: claim.intentId };
  }

  const attempts = attemptCount(deps.db, intent.intentId);
  if (attempts >= deps.maxAttemptsPerIntent) {
    return refuse(deps, intent, 'attempt_budget', `${attempts} attempts already made`);
  }

  let order: Awaited<ReturnType<typeof buildSignableOrder>>;
  try {
    setIntentState(deps.db, intent.intentId, 'ORDER_REQUESTED');
    order = await buildSignableOrder(deps.limiter, deps.jupiterApiKey, {
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      amount: intent.maxInputAmount,
      slippageBps: deps.slippageBps,
      taker: deps.signer.publicKey,
    });
  } catch (e) {
    const detail = e instanceof OrderBuildError ? e.message : `order request failed: ${(e as Error).message}`;
    return refuse(deps, intent, 'order_unavailable', detail);
  }

  const rawBase64 = Buffer.from(order.transaction).toString('base64');
  let decoded;
  try {
    decoded = decodeTransaction(order.transaction);
  } catch (e) {
    const detail = e instanceof TxDecodeError ? e.message : (e as Error).message;
    return refuse(deps, intent, 'undecodable', detail);
  }

  const effect = await verifyEffect(deps.rpc, rawBase64, decoded, intent, deps.signer.publicKey);
  setIntentState(deps.db, intent.intentId, 'ORDER_VALIDATED');

  const outcome = deps.signer.sign({ raw: order.transaction, intent, effect, nowUtcMs: Date.now() });
  if (!outcome.signed) {
    return refuse(deps, intent, outcome.kind, outcome.detail);
  }

  // The blockhash belongs to the transaction Jupiter built; its deadline does
  // not. `lastValidBlockHeight` read now is an upper bound on when that hash
  // dies, which makes an expiry verdict conservative in the safe direction: we
  // may call something unresolved for longer than necessary, never sooner.
  let lastValidHeight: number;
  try {
    lastValidHeight = (await deps.rpc.getLatestBlockhash()).lastValidBlockHeight;
  } catch (e) {
    return refuse(deps, intent, 'no_expiry_bound', `cannot read block height: ${(e as Error).message}`);
  }

  const attemptId = newId();
  // Durable before the wire. Everything after this point can be reconstructed
  // from the chain using this signature; nothing before it needs to be.
  recordAttempt(deps.db, {
    attemptId,
    intentId: intent.intentId,
    attemptNo: attempts + 1,
    signature: outcome.signature,
    blockhash: decoded.recentBlockhash,
    lastValidHeight,
    signedUtcMs: Date.now(),
    simulatedOut: effect.outputDelta,
    simulatedIn: effect.inputDelta,
  });
  setIntentState(deps.db, intent.intentId, 'SIGNED');

  try {
    const returned = await deps.rpc.send(outcome.transactionBase64);
    if (returned !== outcome.signature) {
      // The cluster echoing a different signature means the bytes it accepted
      // are not the bytes we signed. Recorded loudly; both are then tracked.
      recordHealth(
        deps.db,
        'signature_mismatch',
        'critical',
        `sent ${outcome.signature}, cluster reported ${returned}`,
      );
    }
    updateAttempt(deps.db, attemptId, { outcome: 'SUBMITTED', sentUtcMs: Date.now() });
    setIntentState(deps.db, intent.intentId, 'SUBMITTED');
  } catch (e) {
    // A failed send is not a transaction that did not happen. It is a
    // transaction whose fate we do not know, and the distinction is the whole
    // reason the attempt row was written first.
    updateAttempt(deps.db, attemptId, {
      outcome: 'UNKNOWN',
      sendError: (e as Error).message.slice(0, 500),
      sentUtcMs: Date.now(),
    });
    setIntentState(deps.db, intent.intentId, 'UNKNOWN');
    deps.log({ event: 'send.unknown', signature: outcome.signature, error: (e as Error).message });
    return { status: 'unknown', signature: outcome.signature, detail: (e as Error).message };
  }

  return await confirm(deps, attemptId, intent.intentId, outcome.signature, lastValidHeight);
}

async function confirm(
  deps: ExecutorDeps,
  attemptId: string,
  intentId: string,
  signature: string,
  lastValidHeight: number,
): Promise<ExecutionResult> {
  const deadline = Date.now() + deps.confirmTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    let status: Awaited<ReturnType<ExecutionRpc['getSignatureStatus']>>;
    try {
      status = await deps.rpc.getSignatureStatus(signature);
    } catch {
      continue;
    }
    if (status !== null) {
      const failed = status.err !== null;
      const detail = failed ? JSON.stringify(status.err).slice(0, 500) : '';
      updateAttempt(deps.db, attemptId, {
        outcome: failed ? 'FAILED' : 'CONFIRMED',
        landedSlot: status.slot,
        chainError: failed ? detail : null,
        resolvedUtcMs: Date.now(),
      });
      setIntentState(deps.db, intentId, failed ? 'FAILED' : 'CONFIRMED');
      return failed
        ? { status: 'failed', signature, detail }
        : { status: 'confirmed', signature, slot: status.slot, attemptId };
    }
    try {
      if ((await deps.rpc.getBlockHeight()) > lastValidHeight) {
        updateAttempt(deps.db, attemptId, { outcome: 'EXPIRED', resolvedUtcMs: Date.now() });
        setIntentState(deps.db, intentId, 'EXPIRED');
        return { status: 'failed', signature, detail: 'blockhash expired without landing' };
      }
    } catch {
      // Height unavailable; keep polling for the status instead.
    }
  }

  updateAttempt(deps.db, attemptId, { outcome: 'UNKNOWN' });
  setIntentState(deps.db, intentId, 'UNKNOWN');
  return { status: 'unknown', signature, detail: `no status within ${deps.confirmTimeoutMs}ms` };
}

function refuse(deps: ExecutorDeps, intent: TradeIntent, kind: string, detail: string): ExecutionResult {
  recordSignRefusal(deps.db, intent.intentId, kind, detail);
  // Terminal: the intent produced no transaction and will not be retried under
  // the same idempotency key. A later cycle may form a fresh intent.
  setIntentState(deps.db, intent.intentId, 'FAILED');
  deps.log({ event: 'execution.refused', intentId: intent.intentId, kind, detail });
  return { status: 'refused', kind, detail };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
