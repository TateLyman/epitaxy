import { randomUUID } from 'node:crypto';
import type { Db } from '../../../packages/storage/src/db.js';
import { insertBuildAttempt, recordHealth } from '../../../packages/storage/src/repo.js';
import { storeRawPayload } from '../../../packages/storage/src/provenance-repo.js';
import type { JupiterClient, BuildOutcome } from '../../../packages/adapters/src/jupiter/client.js';
import {
  evaluateInstructionPolicy,
  instructionPolicyLimits,
  policyStatusLabel,
} from '../../../packages/solana/src/instructionpolicy.js';
import type { RequestPriority } from '../../../packages/adapters/src/ratelimit.js';

/**
 * One structural build check, fully recorded.
 *
 * P2a.1 §P0.2. Both legs go through here, which is the point: the entry leg was
 * gated first and the exit leg was not, so a position could be opened on a
 * proven-buildable route and closed against a price nobody had shown could be
 * traded. A trade is only `PAPER_PNL_ELIGIBLE` when BOTH legs built, and one
 * function producing both records is what makes that checkable.
 *
 * What this establishes and what it does not:
 *
 *   established   a transaction could be CONSTRUCTED for this route, at this
 *                 size, at this moment, and its instructions satisfy the same
 *                 program allowlist, instruction cap, signer rule and priority
 *                 fee cap the executor applies;
 *   NOT           that it would land, that the taker could pay for it, or that
 *                 a mainnet simulation succeeded.
 *
 * `simulationStatus` is therefore written as an explicit
 * `NOT_SIMULATED(reason)` string rather than left to look like an omission. For
 * a paper sell no mainnet simulation is even meaningful: the taker does not own
 * the hypothetical tokens, so a failure would say nothing about the route. The
 * directive names both of the tempting shortcuts — claiming mainnet simulation
 * from a wallet without the token, and silently downgrading to quote-only — and
 * neither is taken.
 */

export const SIMULATION_NOT_RUN_BUY =
  'NOT_SIMULATED(no local SVM fixture wired; structural build only)';
export const SIMULATION_NOT_RUN_SELL =
  'NOT_SIMULATED(taker does not hold the hypothetical tokens; a mainnet simulation would fail for a reason unrelated to the route)';

export interface LegRequest {
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly positionId: string | null;
  readonly quoteId: string | null;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amount: bigint;
  readonly taker: string;
  readonly slippageBps: number;
  readonly maxPriorityFeeLamports: bigint;
  readonly priority: RequestPriority;
  readonly contextHash: string | null;
}

export interface LegResult {
  /** True only when a transaction could be built AND policy passed. */
  readonly buildable: boolean;
  readonly buildId: string;
  readonly outcome: BuildOutcome | null;
  readonly policyStatus: string | null;
  readonly reason: string;
}

/**
 * Build, decode, and persist — in that order, and always all three.
 *
 * The attempt row is written whether or not the build succeeded. A refused leg
 * is as much a fact about the route as an accepted one, and without the
 * failures the corpus cannot say what fraction of eligible candidates were
 * actually tradable. The engine previously stored nothing at all for a route it
 * declined.
 */
export async function checkLeg(db: Db, jupiter: JupiterClient, req: LegRequest): Promise<LegResult> {
  const buildId = randomUUID();

  const built = await jupiter.build({
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: req.amount,
    taker: req.taker,
    slippageBps: req.slippageBps,
    priority: req.priority,
  });

  let rawHash: string | null = null;
  if (built !== null) {
    rawHash = storeRawPayload(db, 'jupiter.swap.v2.build', built.endpoint, built.rawBody, built.receivedUtcMs);
  }

  // Policy runs only on a build that produced instructions. Running it on an
  // empty set would produce a vacuous pass, which is the shape of every defect
  // this session has been repairing.
  let policyStatus: string | null = null;
  let policyAllowed = false;
  if (built !== null && built.buildable && built.instructions.length > 0) {
    const policy = evaluateInstructionPolicy(
      built.instructions,
      instructionPolicyLimits(req.taker, req.maxPriorityFeeLamports),
    );
    policyStatus = policyStatusLabel(policy);
    policyAllowed = policy.allowed;
  }

  const buildStatus = built === null ? 'UNVERIFIABLE' : built.buildable ? 'BUILD_SUCCEEDED' : 'BUILD_FAILED';

  insertBuildAttempt(db, {
    buildId,
    mint: req.mint,
    side: req.side,
    positionId: req.positionId,
    quoteId: req.quoteId,
    requestedUtcMs: built?.requestedUtcMs ?? Date.now(),
    receivedUtcMs: built?.receivedUtcMs ?? null,
    latencyMs: built?.latencyMs ?? null,
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: req.amount,
    taker: req.taker,
    slippageBps: req.slippageBps,
    buildEndpoint: built?.endpoint ?? '/swap/v2/build',
    buildRouter: built?.router ?? null,
    buildRequestId: built?.requestId ?? null,
    buildStatus,
    buildErrorCode: built?.errorCode ?? null,
    buildErrorClass: built === null ? 'request_failed' : built.errorMessage,
    instructionCount: built?.instructionCount ?? null,
    programIds: built?.programIds ?? null,
    hasSetup: built?.hasSetup ?? null,
    hasCleanup: built?.hasCleanup ?? null,
    // A digest of the instruction set, not of a transaction. /build returns no
    // bytes, and the column name predates that distinction.
    transactionBytesHash: built?.instructionSetHash ?? null,
    lastValidBlockHeight: built?.lastValidBlockHeight ?? null,
    expireAt: built?.expireAt ?? null,
    // The slot the QUOTE priced against is not available on the build response;
    // NULL says so rather than copying the build slot into both columns and
    // making a single observation look like two agreeing ones.
    quoteContextSlot: null,
    buildContextSlot: built?.contextSlot ?? null,
    policyStatus,
    simulationStatus: req.side === 'sell' ? SIMULATION_NOT_RUN_SELL : SIMULATION_NOT_RUN_BUY,
    contextHash: req.contextHash,
  });

  if (built === null) {
    return { buildable: false, buildId, outcome: null, policyStatus, reason: 'build request failed' };
  }
  if (!built.buildable) {
    return {
      buildable: false,
      buildId,
      outcome: built,
      policyStatus,
      reason: built.errorMessage ?? `errorCode ${built.errorCode ?? 'unknown'}`,
    };
  }
  if (!policyAllowed) {
    // A route that builds but violates policy is worse than one that does not
    // build: it looks tradable and is not. Recorded loudly.
    recordHealth(db, 'build_policy_refused', 'warn', `${req.side} ${req.mint.slice(0, 12)}: ${policyStatus}`);
    return { buildable: false, buildId, outcome: built, policyStatus, reason: policyStatus ?? 'policy refused' };
  }

  void rawHash;
  return { buildable: true, buildId, outcome: built, policyStatus, reason: '' };
}
