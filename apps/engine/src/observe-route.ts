import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../../../packages/storage/src/db.js';
import { recordHealth } from '../../../packages/storage/src/repo.js';
import { storeRawPayload } from '../../../packages/storage/src/provenance-repo.js';
import { insertObservation } from '../../../packages/storage/src/observation-repo.js';
import type { JupiterClient } from '../../../packages/adapters/src/jupiter/client.js';
import {
  evaluateInstructionPolicy,
  instructionPolicyLimits,
} from '../../../packages/solana/src/instructionpolicy.js';
import {
  buildPolicyLimits,
  evaluateBuildPolicy,
  buildPolicyStatusLabel,
} from '../../../packages/solana/src/buildpolicy.js';
import {
  compileMessage,
  encodeMessage,
  encodeUnsignedTransaction,
  EncodeError,
} from '../../../packages/solana/src/encode.js';
import { evaluateTransactionPolicy, defaultLimits } from '../../../packages/solana/src/txpolicy.js';
import type { ExecutionObservation, RouteFamily } from '../../../packages/domain/src/execution.js';
import { FAMILY_CONTRACTS } from '../../../packages/domain/src/execution.js';
import type { RequestPriority } from '../../../packages/adapters/src/ratelimit.js';

/**
 * Take ONE exact-size execution observation, fully validated and persisted.
 *
 * Everything a leg needs comes from a single response: the amount, the expected
 * and minimum output, the route plan, the fee model, the instructions, the
 * blockhash and its expiry. Nothing is borrowed from a second call. That is the
 * whole repair — the previous code priced from `/order` and proved buildability
 * from `/build`, which are different routes with different economics.
 *
 * Three gates run, and each records its own answer:
 *
 *   instructionPolicy   program allowlist, instruction cap, signer set,
 *                       compute limit, priority fee — from instructions alone
 *   transactionPolicy   fee payer, signer count, blockhash and its expiry,
 *                       estimated packet size, and ALT-resolved writable
 *                       accounts — the questions that need the whole message
 *   simulation          NOT RUN. See below.
 *
 * On simulation, plainly. A mainnet `simulateTransaction` cannot validate either
 * leg here: the buy fails because the taker holds no SOL, the sell because it
 * holds none of the hypothetical tokens, and both failures would describe the
 * wallet rather than the route.
 *
 * The instrument that CAN answer it now exists. The WSL daemon runs a local SVM,
 * executes transactions, and reproduces settled mainnet fees to the lamport.
 * What is still missing is what to feed it: an account-snapshot capture pipeline,
 * and the program ELFs a route's programs have to be deployed from -- measured
 * against surfpool 1.5.0, `setAccount` has no executable parameter, so a program
 * cannot be restored from a snapshot at all.
 *
 * Until both exist, every observation carries `NOT_SIMULATED` with that reason
 * attached, and `config.requireLocalSimulation` turns it into a refusal rather
 * than a footnote. Sending a route to the daemon without its snapshot would
 * produce a confident answer about a chain state that never existed, which is
 * worse than answering nothing.
 */

export const SIMULATION_UNAVAILABLE =
  'a local SVM is wired and executes, but no account snapshot is captured for this route and no program ' +
  'ELFs are available to deploy its programs from, so there is nothing to simulate it against. A mainnet ' +
  'simulateTransaction cannot substitute: the taker holds no SOL so a buy fails on funding, and holds none ' +
  'of the hypothetical tokens so a sell fails on balance, and both failures describe the wallet rather ' +
  'than the route. See docs/SIMULATOR_PARITY.md.';

export interface ObservationRequest {
  readonly family: RouteFamily;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly positionId: string | null;
  readonly shadowPositionId: string | null;
  /** Why this observation was taken: entry | mark | exit | benchmark. */
  readonly purpose: string;
  readonly inputMint: string;
  readonly outputMint: string;
  /** The EXACT amount. Never a probe scaled to something else. */
  readonly amount: bigint;
  readonly taker: string;
  readonly slippageBps: number;
  readonly maxPriorityFeeLamports: bigint;
  readonly broadcasterTipLamports: bigint;
  readonly priority: RequestPriority;
  readonly contextHash: string | null;
}

/**
 * Always returns an observation, never null.
 *
 * A failed attempt is as much a fact about the route as a successful one, and a
 * corpus that stores only successes cannot say what fraction of eligible
 * candidates were tradable.
 */
export async function observeRoute(
  db: Db,
  jupiter: JupiterClient,
  req: ObservationRequest,
): Promise<ExecutionObservation> {
  if (req.family !== 'BUILD_CUSTOM') {
    // The only family that returns quote and instructions in one response, and
    // therefore the only one that can back a coherent leg today.
    throw new Error(
      `observeRoute supports BUILD_CUSTOM only; ${req.family} would require a second call and a second route`,
    );
  }

  const built = await jupiter.build({
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: req.amount,
    taker: req.taker,
    slippageBps: req.slippageBps,
    priority: req.priority,
  });

  const rawPayloadHash =
    built.rawBody.length > 0
      ? storeRawPayload(db, 'jupiter.swap.v2.build', built.endpoint, built.rawBody, built.receivedUtcMs)
      : null;

  let instructionPolicy: ExecutionObservation['instructionPolicy'] = 'NOT_RUN';
  let transactionPolicy: ExecutionObservation['transactionPolicy'] = 'NOT_RUN';
  let policyDetail: string | null = null;
  let computeUnitLimit: number | null = null;
  let estimatedBytes: number | null = null;
  let writableAccounts: readonly string[] = [];
  let assembled: {
    serializedHash: string;
    messageHash: string;
    packetBytes: number;
    feePayer: string;
    requiredSignatures: number;
    staticAccountKeys: readonly string[];
    writableAccounts: readonly string[];
    readonlyAccounts: readonly string[];
    base64: string;
  } | null = null;

  if (built.buildable && built.instructions.length > 0) {
    const ix = evaluateInstructionPolicy(
      built.instructions,
      instructionPolicyLimits(req.taker, req.maxPriorityFeeLamports),
    );
    instructionPolicy = ix.allowed ? 'PASS' : 'FAIL';

    const tx = evaluateBuildPolicy(
      {
        instructions: built.instructions,
        lookupTables: built.lookupTables,
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
      },
      buildPolicyLimits(req.taker, req.maxPriorityFeeLamports),
    );
    // The response's own limit, which is null on every observed route. The
    // affordable ceiling is OUR number and is not stored as if it were theirs.
    computeUnitLimit = tx.computeUnitLimit;
    writableAccounts = tx.writableAccounts;

    // §5 — assemble the EXACT bytes and run the strict byte-level policy over
    // them. Everything above reasons about instructions and estimates a packet
    // size; none of it can see the fee payer's compiled position, the real
    // signature count, or the true packet length, and a simulator cannot be
    // handed an estimate.
    //
    // A missing decision-bearing field fails explicitly here rather than
    // becoming a zero — that is the whole reason EncodeError carries a code.
    try {
      const message = compileMessage(
        built.instructions,
        req.taker,
        built.blockhash ?? '',
        built.lookupTables,
      );
      const bytes = encodeUnsignedTransaction(message);
      assembled = {
        serializedHash: createHash('sha256').update(bytes).digest('hex'),
        messageHash: createHash('sha256').update(encodeMessage(message)).digest('hex'),
        packetBytes: bytes.length,
        feePayer: message.feePayer,
        requiredSignatures: message.numRequiredSignatures,
        staticAccountKeys: message.staticAccountKeys,
        writableAccounts: message.writableAccounts,
        readonlyAccounts: message.readonlyAccounts,
        base64: Buffer.from(bytes).toString('base64'),
      };
      // The real thing: the same function the signer relies on, over real bytes.
      const byteLevel = evaluateTransactionPolicy(
        bytes,
        defaultLimits(req.taker, req.maxPriorityFeeLamports),
      );
      transactionPolicy = byteLevel.allowed ? 'PASS' : 'FAIL';
      estimatedBytes = bytes.length;
      policyDetail =
        `${ix.allowed ? 'IX_PASS' : `IX_FAIL(${ix.violations.map((v) => v.violation).join(',')})`} ` +
        `${buildPolicyStatusLabel(tx)} ` +
        `${byteLevel.allowed ? 'BYTES_PASS' : `BYTES_FAIL(${byteLevel.violations.map((v) => v.violation).join(',')})`}`;
    } catch (e) {
      // Assembly failed, so there are no bytes and there is no transaction
      // policy result. NOT_RUN, never a pass.
      transactionPolicy = 'FAIL';
      estimatedBytes = tx.estimatedBytes;
      const code = e instanceof EncodeError ? e.code : 'ASSEMBLY_FAILED';
      policyDetail =
        `${ix.allowed ? 'IX_PASS' : 'IX_FAIL'} ${buildPolicyStatusLabel(tx)} BYTES_FAIL(${code}: ${(e as Error).message.slice(0, 100)})`;
    }
  }

  const contract = FAMILY_CONTRACTS[req.family];
  const observation: ExecutionObservation = {
    observationId: randomUUID(),
    family: req.family,
    mint: req.mint,
    side: req.side,
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    requestedAmount: req.amount,
    expectedOutput: built.outAmount,
    minimumOutput: built.otherAmountThreshold ?? 0n,
    slippageBps: built.slippageBps ?? req.slippageBps,
    // /build carries no fee fields at all — verified live. Null is the honest
    // record of that, and `feeIncludedInAmounts` on the family contract is
    // false, so nothing is deducted twice and nothing is invented.
    platformFeeBps: null,
    platformFeeAmount: null,
    platformFeeMint: null,
    signatureFeeLamports: null,
    prioritizationFeeLamports: null,
    rentFeeLamports: null,
    broadcasterTipLamports: req.broadcasterTipLamports,
    routePlanHash: built.routePlanHash,
    routeLabels: built.routeLabels,
    instructionSetHash: built.instructionSetHash.length > 0 ? built.instructionSetHash : null,
    instructionCount: built.instructionCount,
    computeUnitLimit,
    transactionBytes: estimatedBytes,
    lastValidBlockHeight: built.lastValidBlockHeight,
    expireAt: built.expireAt,
    contextSlot: built.contextSlot,
    rawPayloadHash,
    endpoint: built.endpoint,
    requestId: built.requestId,
    instructionPolicy,
    transactionPolicy,
    simulation: 'NOT_SIMULATED',
    policyDetail,
    simulationDetail: SIMULATION_UNAVAILABLE,
    requestedUtcMs: built.requestedUtcMs,
    receivedUtcMs: built.receivedUtcMs,
    latencyMs: built.latencyMs,
    contextHash: req.contextHash,
  };

  insertObservation(db, observation, {
    positionId: req.positionId,
    shadowPositionId: req.shadowPositionId,
    purpose: req.purpose,
    failure: built.failure,
    impactStatus: built.impact.status,
    impactRawString: built.impact.rawString,
    adverseImpactBps: built.impact.adverseBps,
    writableAccounts: assembled?.writableAccounts ?? writableAccounts,
    lookupTables: Object.keys(built.lookupTables),
    assembled,
  });

  if (built.failure !== null && built.failure !== 'NO_ROUTE') {
    // A provider failing is not a token being untradeable. Recorded as what it
    // is so the corpus can tell a 429 from a drained pool.
    recordHealth(db, 'observation_provider_failure', 'warn', `${req.side} ${req.mint.slice(0, 12)}: ${built.failure}`);
  }

  void contract;
  return observation;
}
