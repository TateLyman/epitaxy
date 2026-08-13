import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  SIMULATION_PROTOCOL_VERSION,
  computeRequestHash,
  type SimulationRequest,
  type SimulationResponse,
  type ParityRequest,
  type ParityCaseResult,
  type ParityResponse,
} from '../../../packages/simulator/src/protocol.js';
import { computeIdentity, assertLinuxFilesystem } from './identity.js';
import {
  decodeTransaction,
  readComputeBudget,
  priorityFeeLamports,
  writableStaticKeys,
  type DecodedTransaction,
} from '../../../packages/solana/src/transaction.js';

/**
 * The simulation daemon.
 *
 * Runs inside WSL, in the Linux filesystem, bound to loopback. It holds no key,
 * has no signing endpoint, no submission method, no shell, and no way to reach
 * the engine's database — it does not know where that database is and would
 * refuse to be told.
 *
 * Four endpoints and nothing else. Surfpool's cheatcodes are used INTERNALLY to
 * set up a job's state; none of them is reachable from the wire. A daemon that
 * exposed `setAccount` to a caller would be a program that lets a network peer
 * write arbitrary chain state, which is a different and much worse thing than a
 * simulator.
 *
 * One job at a time, one fresh Surfnet per job. State from one token must never
 * reach another, and the cheapest way to guarantee that is to have nothing
 * survive. Startup was measured at 55-102ms, which fits inside a 10.5s mark
 * cadence with room to spare; if that stops being true the answer is a bounded
 * warm pool where each worker is still destroyed between jobs, not a shared
 * instance.
 */

const HOST = '127.0.0.1';
const PORT = Number(process.env['SIMULATORD_PORT'] ?? 8787);
const TOKEN = process.env['SIMULATORD_TOKEN'] ?? '';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * §3.1 — one Surfnet at a time, and do not optimise this yet.
 *
 * The daemon documented "fresh instance per job" and then permitted sixteen at
 * once, each starting its own SVM and binding its own ports. Isolation was
 * asserted by the comment and not enforced by anything. Startup was measured at
 * 23-24 ms, so serialising costs almost nothing, and a bounded warm pool is a
 * thing to build when measured throughput demands it rather than in advance.
 */
const MAX_ACTIVE_SURFNETS = 1;
/** Bounded FIFO. A queue that can grow without limit is a memory leak with a plan. */
const MAX_QUEUED = 16;
/** Bounded retry memory: a cache for retries, not a ledger. Windows holds that. */
const MAX_CACHED_JOBS = 512;

/**
 * How many accounts we ask the runtime to return post-simulation state for.
 *
 * The fee decomposition below is only exact when every account that could have
 * received lamports is visible, so this is not a display limit — exceeding it
 * costs us the ability to name the priority fee, and that is recorded rather
 * than papered over.
 */
const MAX_WATCHED_ACCOUNTS = 64;

/** Named once. Measured against three settled mainnet transactions. */
const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
/** SPL token account layout: mint(32) owner(32) amount(u64 LE) — amount at 64. */
const TOKEN_AMOUNT_OFFSET = 64;

const REPO_ROOT = resolve(process.cwd());
assertLinuxFilesystem(REPO_ROOT);

if (TOKEN.length < 16) {
  console.error(
    'SIMULATORD_TOKEN must be set to at least 16 characters. The daemon is loopback-only, but a local ' +
      'token is what stops any other process on this machine driving it.',
  );
  process.exit(2);
}

/**
 * The Surfnet surface this daemon uses, transcribed from @solana/surfpool
 * 1.5.0's own typings.
 *
 * `setAccount` is POSITIONAL — `(address, lamports, data, owner)` — and takes a
 * Uint8Array. Calling it with an options object throws "undefined is not
 * iterable", which is exactly the sort of failure a hand-written interface
 * invites; this one is copied from the real declaration rather than guessed.
 *
 * Note what is absent: there is no `executable` parameter. An executable
 * account CANNOT be restored with setAccount, which is why `deploy` exists
 * below and why a snapshot containing a program without its ELF is refused.
 */
interface SurfnetInstance {
  readonly rpcUrl: string;
  readonly payer: string;
  stop(): void;
  drainEvents(): { kind: string; message?: string; computeUnitsConsumed?: number; fee?: number }[];
  fundSol(address: string, lamports: number): void;
  setTokenBalance(owner: string, mint: string, amount: number, tokenProgram?: string): void;
  setAccount(address: string, lamports: number, data: Uint8Array, owner: string): void;
  deploy(options: { programId: string; soPath?: string; soBytes?: number[] }): string;
  getAta(owner: string, mint: string, tokenProgram?: string): string;
}
interface SurfnetModule {
  Surfnet: { start(): SurfnetInstance; startWithConfig(c: Record<string, unknown>): SurfnetInstance };
}

const require = createRequire(import.meta.url);
const surfpool = require('@solana/surfpool') as SurfnetModule;

let runtimeVersion: string | null = null;
let featureSet: string | null = null;
let active = 0;
let jobsRun = 0;
let jobsFailed = 0;
let jobsUnknown = 0;
const startupSamples: number[] = [];
const simulateSamples: number[] = [];

/** jobId -> {requestHash, response}. Idempotency, and refusal on a mismatch. */
const completed = new Map<string, { requestHash: string; response: SimulationResponse }>();

/**
 * §3.2 — in-flight idempotency.
 *
 * The completed-job cache could not help a job that was still running, so a
 * client timeout at 60 s followed by a retry started a SECOND simulation of the
 * same work under the same job id. Two Surfnets, two answers, one job id, and
 * whichever finished last won. A retry has to ATTACH to the work already in
 * progress, not race it.
 */
const inFlight = new Map<string, { requestHash: string; promise: Promise<SimulationResponse>; startedUtcMs: number }>();

/**
 * The bounded FIFO. Each entry waits for its turn to be the single active job.
 *
 * Queue position is taken before the work starts and released in a finally, so
 * a throwing job cannot wedge the queue closed.
 */
const waiting: { enqueuedUtcMs: number; release: () => void }[] = [];

async function acquireSlot(): Promise<{ queueWaitMs: number; release: () => void }> {
  const enqueuedUtcMs = Date.now();
  if (active < MAX_ACTIVE_SURFNETS) {
    active += 1;
    return { queueWaitMs: 0, release: releaseSlot };
  }
  await new Promise<void>((resolve) => {
    waiting.push({ enqueuedUtcMs, release: resolve });
  });
  active += 1;
  return { queueWaitMs: Date.now() - enqueuedUtcMs, release: releaseSlot };
}

function releaseSlot(): void {
  active -= 1;
  const next = waiting.shift();
  if (next !== undefined) next.release();
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function sample(into: number[], value: number): void {
  into.push(value);
  if (into.length > 200) into.shift();
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (body['error'] !== undefined) throw new Error(`${method}: ${JSON.stringify(body['error']).slice(0, 200)}`);
  return body['result'] ?? null;
}

/** Learn the runtime's identity once, from a throwaway instance. */
async function probeRuntime(): Promise<void> {
  const net = surfpool.Surfnet.start();
  try {
    const v = (await rpc(net.rpcUrl, 'getVersion', [])) as Record<string, unknown>;
    runtimeVersion = typeof v['solana-core'] === 'string' ? (v['solana-core'] as string) : null;
    featureSet = v['feature-set'] === undefined ? null : String(v['feature-set']);
  } finally {
    net.stop();
  }
}

/**
 * §3.4 — cross a bigint into a native binding that only accepts JS numbers, or
 * refuse. Never round.
 *
 * @solana/surfpool 1.5.0 types every amount as `number`: fundSol(lamports),
 * setTokenBalance(amount), setAccount(lamports). There is no bigint transport
 * in this version, so the choice is exactness or refusal, and silent rounding
 * is not on the list.
 *
 * This is not hypothetical. A fresh memecoin with a one-billion supply and nine
 * decimals is 10^18 atoms; 2^53-1 is about 9.007 x 10^15. Ordinary positions in
 * exactly the tokens this system trades exceed the safe integer range by three
 * orders of magnitude, and `Number()` on one of them changes the size of the
 * position without saying so.
 *
 * SOL amounts are safe in practice -- 2^53-1 lamports is roughly nine million
 * SOL -- but the guard applies to both, because the reason it holds for SOL is
 * a fact about how small our positions are, not a property of the type.
 */
export class UnsafeAmount extends Error {
  constructor(
    readonly field: string,
    readonly value: bigint,
  ) {
    super(
      `${field} is ${value.toString()}, above Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
        'The Surfpool binding accepts only JS numbers, so this value cannot be passed exactly. ' +
        'Refusing rather than rounding: a token amount that changes when it crosses a boundary is ' +
        'a position of a different size.',
    );
    this.name = 'UnsafeAmount';
  }
}

export function exactNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnsafeAmount(field, value);
  }
  return Number(value);
}

/** An account as the runtime describes it, or absent. Absent is not zero. */
interface AccountView {
  readonly lamports: bigint;
  readonly owner: string;
  readonly data: Buffer;
  readonly executable: boolean;
}

function viewOf(raw: unknown): AccountView | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const d = o['data'];
  const b64 = Array.isArray(d) ? String(d[0]) : typeof d === 'string' ? d : '';
  return {
    lamports: BigInt(String(o['lamports'] ?? 0)),
    owner: String(o['owner'] ?? ''),
    data: Buffer.from(b64, 'base64'),
    executable: o['executable'] === true,
  };
}

/** Token amount, or null when this is not a token account. Never 0 by default. */
function tokenAmount(v: AccountView | null): bigint | null {
  if (v === null) return null;
  if (!TOKEN_PROGRAMS.has(v.owner)) return null;
  if (v.data.length < TOKEN_AMOUNT_OFFSET + 8) return null;
  return v.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}

function hashView(pubkey: string, v: AccountView | null): string {
  const canonical =
    v === null
      ? { pubkey, absent: true }
      : {
          pubkey,
          lamports: v.lamports.toString(),
          owner: v.owner,
          executable: v.executable,
          data: v.data.toString('base64'),
        };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function readAccounts(url: string, keys: readonly string[]): Promise<Map<string, AccountView | null>> {
  const out = new Map<string, AccountView | null>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = (await rpc(url, 'getMultipleAccounts', [chunk, { encoding: 'base64' }])) as Record<string, unknown> | null;
    const values = (r?.['value'] ?? []) as unknown[];
    chunk.forEach((k, j) => out.set(k, viewOf(values[j] ?? null)));
  }
  return out;
}

/**
 * The bytes the runtime prices, which is the message and not the transaction.
 *
 * `getFeeForMessage` was measured to return the BASE fee only — 5,000 lamports
 * both with and without compute-budget instructions — so the priority fee has
 * to come from somewhere else, and it does: the transaction's own bytes.
 */
function messageBase64(tx: DecodedTransaction): string {
  return Buffer.from(tx.messageBytes).toString('base64');
}

async function runJob(req: SimulationRequest, queueWaitMs: number): Promise<SimulationResponse> {
  const t0 = Date.now();
  const jit = req.mode === 'DEVELOPMENT_JIT';

  // §10 — a confirmatory run is offline. Missing snapshot state fails closed
  // rather than being quietly fetched, because a fetch makes the run
  // unreproducible and that is precisely what confirmatory means.
  if (!jit && req.snapshotAccounts.length === 0) {
    return fail(req, 'SIMULATOR_UNAVAILABLE', 'CONFIRMATORY_OFFLINE requires a frozen account snapshot; none supplied', t0, queueWaitMs, 0, 0);
  }

  // A JIT run needs somewhere to fetch FROM. Without it Surfpool waits on an
  // empty endpoint and the request hangs until the client's timeout, which is
  // the worst failure mode available: the caller learns nothing, slowly. Fail
  // fast and say which knob is missing.
  const remote = process.env['SIMULATORD_REMOTE_RPC'] ?? '';
  if (jit && remote.length === 0) {
    return fail(
      req,
      'SIMULATOR_UNAVAILABLE',
      'DEVELOPMENT_JIT requested but SIMULATORD_REMOTE_RPC is unset; there is nowhere to fetch from',
      t0,
      queueWaitMs,
      0,
      0,
    );
  }

  // Decode before starting anything. Bytes we cannot read are refused rather
  // than handed to the runtime to interpret for us.
  let original: DecodedTransaction;
  try {
    original = decodeTransaction(Buffer.from(req.transactionBase64, 'base64'));
  } catch (e) {
    return fail(req, 'SIMULATOR_UNAVAILABLE', `transaction bytes did not decode: ${(e as Error).message}`, t0, queueWaitMs, 0, 0);
  }

  // Checked BEFORE a Surfnet is started. An amount we cannot pass exactly is a
  // fact about the request, and starting an SVM to discover it wastes the slot.
  for (const a of req.snapshotAccounts) {
    try {
      exactNumber(BigInt(a.lamports), `snapshot lamports for ${a.pubkey}`);
    } catch (e) {
      return fail(req, 'SIMULATOR_UNAVAILABLE', (e as Error).message, t0, queueWaitMs, 0, 0);
    }
  }
  for (const m of req.balanceMutations) {
    try {
      exactNumber(BigInt(m.amount), `${m.kind} mutation for ${m.owner}`);
    } catch (e) {
      return fail(req, 'SIMULATOR_UNAVAILABLE', (e as Error).message, t0, queueWaitMs, 0, 0);
    }
  }

  // §13 — measured against @solana/surfpool 1.5.0: `setAccount` has no
  // `executable` parameter, so a program account restored through it comes back
  // NON-executable and every route through it fails with an invalid-program
  // error. That error would look like a fact about the token and it is a fact
  // about us. Programs are deployed from their ELF or the request is refused.
  const missingElf = req.snapshotAccounts.filter((a) => a.executable && (a.programElfBase64 ?? null) === null);
  if (missingElf.length > 0) {
    return fail(
      req,
      'SIMULATOR_UNAVAILABLE',
      `snapshot contains ${missingElf.length} executable account(s) with no programElfBase64 ` +
        `(${missingElf.slice(0, 3).map((a) => a.pubkey.slice(0, 8)).join(', ')}); setAccount cannot mark an ` +
        'account executable, so restoring these would silently produce a non-executable program',
      t0,
      queueWaitMs,
      0,
      0,
    );
  }

  const net = jit
    ? surfpool.Surfnet.startWithConfig({ offline: false, remoteRpcUrl: remote })
    : surfpool.Surfnet.start();
  const startupMs = Date.now() - t0;

  try {
    // §13 — typed methods, not raw pokes.
    for (const a of req.snapshotAccounts) {
      if (a.executable) {
        net.deploy({ programId: a.pubkey, soBytes: [...Buffer.from(a.programElfBase64 ?? '', 'base64')] });
      } else {
        net.setAccount(
          a.pubkey,
          exactNumber(BigInt(a.lamports), `snapshot lamports for ${a.pubkey}`),
          new Uint8Array(Buffer.from(a.dataBase64, 'base64')),
          a.owner,
        );
      }
    }

    // Token accounts go through the token cheatcodes, which create the ATA and
    // respect Token-2022 when the program is named. The ATA addresses are
    // collected because they are where a swap's output actually lands, and an
    // output we do not watch is an output we cannot measure.
    const namedAtas: string[] = [];
    for (const m of req.balanceMutations) {
      if (m.kind === 'sol') {
        net.fundSol(m.owner, exactNumber(BigInt(m.amount), `SOL mutation for ${m.owner}`));
        continue;
      }
      if (m.mint === undefined) continue;
      // Token atoms are where this actually bites: a nine-decimal memecoin with
      // a billion supply is 10^18 atoms, three orders of magnitude past exact.
      const atoms = exactNumber(BigInt(m.amount), `token mutation for ${m.owner}/${m.mint}`);
      if (m.tokenProgram == null) net.setTokenBalance(m.owner, m.mint, atoms);
      else net.setTokenBalance(m.owner, m.mint, atoms, m.tokenProgram);
      try {
        namedAtas.push(m.tokenProgram == null ? net.getAta(m.owner, m.mint) : net.getAta(m.owner, m.mint, m.tokenProgram));
      } catch {
        /* an ATA we cannot derive is one we do not watch, and the fee
           decomposition below will say so rather than assume */
      }
    }
    if (req.bounds.mint !== undefined) {
      try {
        namedAtas.push(net.getAta(req.bounds.feePayer, req.bounds.mint));
      } catch {
        /* as above */
      }
    }

    const allWatched = [
      ...new Set([
        req.bounds.feePayer,
        ...original.staticAccountKeys,
        ...req.snapshotAccounts.map((a) => a.pubkey),
        ...namedAtas,
      ]),
    ];
    const watched = allWatched.slice(0, MAX_WATCHED_ACCOUNTS);
    const truncated = allWatched.length - watched.length;

    const pre = await readAccounts(net.rpcUrl, watched);

    // §14 — the ORIGINAL bytes are preserved. The local SVM has never produced
    // the mainnet blockhash, so a substitution is genuinely required; asking the
    // runtime to do it with `replaceRecentBlockhash` means the bytes we hold are
    // never edited, and the substitution is still recorded, because "the runtime
    // did it" is not the same as "it did not happen".
    const simStart = Date.now();
    const raw = (await rpc(net.rpcUrl, 'simulateTransaction', [
      req.transactionBase64,
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'processed',
        innerInstructions: true,
        // Post-simulation state comes back HERE. Reading it with getBalance
        // afterwards returns the pre-state, because a simulation does not
        // commit — measured, and it is how a run can look like it changed
        // nothing at all.
        accounts: { encoding: 'base64', addresses: watched },
      },
    ])) as Record<string, unknown> | null;
    const simulateMs = Date.now() - simStart;

    const value = (raw?.['value'] ?? null) as Record<string, unknown> | null;
    const err = value?.['err'] ?? null;
    const logs = Array.isArray(value?.['logs']) ? (value['logs'] as string[]) : [];
    const postList = (value?.['accounts'] ?? []) as unknown[];

    // A null in the post array means "the runtime did not return this", which
    // is NOT the same as "this does not exist". Measured: the System Program
    // comes back null from a plain transfer while plainly still existing.
    // Reading null as absent booked it as a closed account and counted its
    // lamport as rent recovered -- a fabricated event in the cost model.
    //
    // An account the transaction cannot write to cannot have changed, so its
    // post-state IS its pre-state. An account of unknown writability -- one
    // loaded from an address lookup table, which this decoder does not resolve
    // -- is neither, and is recorded as unobserved.
    const writable = writableStaticKeys(original);
    const staticKeys = new Set(original.staticAccountKeys);
    const post = new Map<string, AccountView | null>();
    const unobserved: string[] = [];
    watched.forEach((k, i) => {
      const returned = viewOf(postList[i] ?? null);
      if (returned !== null) {
        post.set(k, returned);
        return;
      }
      if (writable.has(k)) {
        // Writable, and the runtime returned nothing: genuinely gone.
        post.set(k, null);
      } else if (staticKeys.has(k) || original.addressTableLookups.length === 0) {
        // Not writable in this transaction, so it is exactly as it was.
        post.set(k, pre.get(k) ?? null);
      } else {
        unobserved.push(k);
        post.set(k, pre.get(k) ?? null);
      }
    });

    const preSol: Record<string, string> = {};
    const postSol: Record<string, string> = {};
    const preTok: Record<string, string> = {};
    const postTok: Record<string, string> = {};
    const mutated: Record<string, string> = {};
    const created: string[] = [];
    const closed: string[] = [];
    let rentCreated = 0n;
    let rentRecovered = 0n;

    for (const k of watched) {
      const a = pre.get(k) ?? null;
      const b = post.get(k) ?? null;
      preSol[k] = (a?.lamports ?? 0n).toString();
      postSol[k] = (b?.lamports ?? 0n).toString();
      const ta = tokenAmount(a);
      const tb = tokenAmount(b);
      // Absent means not a token account here, and is omitted rather than
      // written as zero. A zero token balance and no token account are
      // different facts and this project has been bitten by conflating them.
      if (ta !== null) preTok[k] = ta.toString();
      if (tb !== null) postTok[k] = tb.toString();

      const existedBefore = a !== null && a.lamports > 0n;
      const existsAfter = b !== null && b.lamports > 0n;
      if (!existedBefore && existsAfter) {
        created.push(k);
        rentCreated += b.lamports;
      } else if (existedBefore && !existsAfter) {
        closed.push(k);
        rentRecovered += a.lamports;
      }
      if (hashView(k, a) !== hashView(k, b)) mutated[k] = hashView(k, b);
    }

    // §4 — the fee, decomposed rather than assumed.
    //
    // getFeeForMessage returns the BASE fee only (measured: 5,000 with and
    // without compute-budget instructions). The priority fee is derived from
    // the transaction's own bytes and cross-checked against what the payer
    // actually lost. The runtime charges on the REQUESTED LIMIT, not on units
    // consumed — measured at 2054 microlamports x 200,000 units = 411 lamports
    // while only 450 units were consumed.
    let baseFee: bigint | null = null;
    try {
      const f = (await rpc(net.rpcUrl, 'getFeeForMessage', [messageBase64(original), { commitment: 'processed' }])) as
        | Record<string, unknown>
        | null;
      const v = f?.['value'];
      baseFee = v === null || v === undefined ? null : BigInt(String(v));
    } catch {
      baseFee = null;
    }
    const declaredPriority = priorityFeeLamports(readComputeBudget(original));

    // The independent check: what the payer lost, minus what other watched
    // accounts gained, minus the base fee, should be the priority fee.
    const payerPre = BigInt(preSol[req.bounds.feePayer] ?? '0');
    const payerPost = BigInt(postSol[req.bounds.feePayer] ?? '0');
    let othersGained = 0n;
    for (const k of watched) {
      if (k === req.bounds.feePayer) continue;
      const d = BigInt(postSol[k] ?? '0') - BigInt(preSol[k] ?? '0');
      if (d > 0n) othersGained += d;
    }
    const residual = payerPre - payerPost - othersGained - (baseFee ?? 0n);
    const decompositionExact = err === null && truncated === 0 && unobserved.length === 0 && baseFee !== null;
    const feeNotes: string[] = [];
    if (truncated > 0) feeNotes.push(`${truncated} account(s) beyond the ${MAX_WATCHED_ACCOUNTS} watched were not observed`);
    if (unobserved.length > 0) {
      feeNotes.push(
        `${unobserved.length} watched account(s) may be lookup-table writable and their post-state was not returned; ` +
          'they are carried forward as unchanged and are NOT claimed to be unchanged',
      );
    }
    if (decompositionExact && residual !== declaredPriority) {
      feeNotes.push(`priority fee disagreement: bytes imply ${declaredPriority}, balances imply ${residual}`);
    }
    // Reported only when the transaction's own bytes and the payer's own
    // balance agree. A number two sources disagree about is not a measurement.
    const priorityFee = err !== null ? null : decompositionExact && residual === declaredPriority ? declaredPriority : null;

    // §6 — the caller's asserted bounds are CHECKED, not carried. A bound
    // nothing tests is a comment with a schema.
    const boundsViolations: string[] = [];
    if (err === null) {
      const spent = payerPre - payerPost;
      const cap = BigInt(req.bounds.maxLamportsSpent);
      if (spent > cap) boundsViolations.push(`fee payer spent ${spent} lamports, above the asserted cap of ${cap}`);
      if (req.bounds.mint !== undefined) {
        let ata: string | null = null;
        try {
          ata = net.getAta(req.bounds.feePayer, req.bounds.mint);
        } catch {
          ata = null;
        }
        if (ata === null || !watched.includes(ata)) {
          boundsViolations.push(`token delta for mint ${req.bounds.mint.slice(0, 8)} could not be observed`);
        } else {
          const delta = BigInt(postTok[ata] ?? '0') - BigInt(preTok[ata] ?? '0');
          if (req.bounds.minTokenDelta !== undefined && delta < BigInt(req.bounds.minTokenDelta)) {
            boundsViolations.push(`token delta ${delta} below the asserted minimum ${req.bounds.minTokenDelta}`);
          }
          if (req.bounds.maxTokenDelta !== undefined && delta > BigInt(req.bounds.maxTokenDelta)) {
            boundsViolations.push(`token delta ${delta} above the asserted maximum ${req.bounds.maxTokenDelta}`);
          }
        }
      }
    }

    const rb = (value?.['replacementBlockhash'] ?? null) as Record<string, unknown> | null;
    const replacement: SimulationResponse['blockhashReplacement'] =
      rb === null
        ? null
        : {
            from: req.originalBlockhash,
            to: String(rb['blockhash'] ?? 'unknown'),
            // Proved rather than asserted: the bytes sent to the runtime are the
            // exact bytes the policy validated, so no instruction, account or
            // header field could have changed. The substitution happens inside
            // the runtime, on its own copy.
            instructionsUnchanged: true,
            accountsUnchanged: true,
            headerUnchanged: true,
          };

    const events = net.drainEvents();
    const identity = computeIdentity(REPO_ROOT, { version: runtimeVersion, featureSet });
    const total = Date.now() - t0;
    const notes = [
      jit
        ? 'DEVELOPMENT_JIT: mainnet was reachable during this run, so it is NOT reproducible and NOT confirmatory'
        : `offline from snapshot ${req.snapshotManifestHash.slice(0, 12)}; original transaction bytes unmodified`,
      ...feeNotes,
      'transfer/withheld Token-2022 fees are not measured by this build and are reported as unknown, not zero',
    ];

    return {
      protocolVersion: SIMULATION_PROTOCOL_VERSION,
      jobId: req.jobId,
      requestHash: req.requestHash,
      identity,
      snapshotManifestHash: req.snapshotManifestHash,
      status: value === null ? 'SIMULATION_UNKNOWN' : err === null ? 'SIMULATED_OK' : 'SIMULATION_FAILED',
      transactionError: err === null ? null : JSON.stringify(err),
      logs,
      unitsConsumed: typeof value?.['unitsConsumed'] === 'number' ? (value['unitsConsumed'] as number) : null,
      preSolBalances: preSol,
      postSolBalances: postSol,
      preTokenBalances: preTok,
      postTokenBalances: postTok,
      baseFeeLamports: baseFee === null ? null : baseFee.toString(),
      priorityFeeLamports: priorityFee === null ? null : priorityFee.toString(),
      rentCreatedLamports: rentCreated.toString(),
      rentRecoveredLamports: rentRecovered.toString(),
      // Not measured by this build. Null is the honest answer; zero would be a
      // claim that Token-2022 charged nothing.
      transferFeeLamports: null,
      withheldFeeLamports: null,
      createdAccounts: created,
      closedAccounts: closed,
      mutatedAccountHashes: mutated,
      boundsViolations,
      blockhashReplacement: replacement,
      runtimeEventDigest: createHash('sha256')
        .update(JSON.stringify({ logs, events: events.map((e) => e.kind) }))
        .digest('hex'),
      // §10 — a JIT run must hand back everything it pulled so the observation
      // can be frozen and replayed. Not yet captured, and reported as empty
      // rather than as "there was nothing"; `responseIsConfirmatory` refuses a
      // JIT run outright, so this cannot become evidence in the meantime.
      jitFetchedAccounts: [],
      queueWaitMs,
      startupMs,
      simulateMs,
      totalMs: total,
      detail: notes.join('; '),
    };
  } finally {
    // Destroyed unconditionally. Nothing survives a job.
    try {
      net.stop();
    } catch {
      /* the port will be reclaimed */
    }
    jobsRun += 1;
  }
}

function fail(
  req: SimulationRequest,
  status: SimulationResponse['status'],
  detail: string,
  t0: number,
  queueWaitMs: number,
  startupMs: number,
  simulateMs: number,
): SimulationResponse {
  return {
    protocolVersion: SIMULATION_PROTOCOL_VERSION,
    jobId: req.jobId,
    requestHash: req.requestHash,
    identity: computeIdentity(REPO_ROOT, { version: runtimeVersion, featureSet }),
    snapshotManifestHash: req.snapshotManifestHash,
    status,
    transactionError: null,
    logs: [],
    unitsConsumed: null,
    preSolBalances: {},
    postSolBalances: {},
    preTokenBalances: {},
    postTokenBalances: {},
    baseFeeLamports: null,
    priorityFeeLamports: null,
    rentCreatedLamports: null,
    rentRecoveredLamports: null,
    transferFeeLamports: null,
    withheldFeeLamports: null,
    createdAccounts: [],
    closedAccounts: [],
    mutatedAccountHashes: {},
    boundsViolations: [],
    blockhashReplacement: null,
    runtimeEventDigest: null,
    jitFetchedAccounts: [],
    queueWaitMs,
    startupMs,
    simulateMs,
    totalMs: Date.now() - t0,
    detail,
  };
}

/**
 * §15 -- does this build agree with outcomes the chain already settled?
 *
 * The fee is the part that can be answered offline and exactly: 5,000 lamports
 * per signature plus ceil(unit_price * unit_limit / 1e6), every input to which
 * is in the transaction's own bytes. It does not depend on pool state, so a
 * settled transaction prices identically today. This is the same function the
 * engine uses to cost every leg, so a disagreement here is a costing defect and
 * not a curiosity.
 *
 * Execution parity is reported as NOT ESTABLISHABLE rather than attempted.
 * Replaying a settled transaction needs the accounts as they stood at its slot,
 * which needs an archival node this project does not have.
 */
function runParity(req: ParityRequest): ParityResponse {
  const cases: ParityCaseResult[] = [];
  for (const c of req.cases) {
    let tx: DecodedTransaction;
    try {
      tx = decodeTransaction(Buffer.from(c.transactionBase64, 'base64'));
    } catch (e) {
      cases.push({
        signature: c.signature,
        numRequiredSignatures: 0,
        unitLimit: null,
        unitPriceMicroLamports: null,
        observedFeeLamports: c.observedFeeLamports,
        modelBaseFeeLamports: '0',
        modelPriorityFeeLamports: '0',
        modelTotalFeeLamports: '0',
        feeParity: false,
        executionParity: 'NOT_ESTABLISHABLE_WITHOUT_ARCHIVAL_STATE',
        detail: `bytes did not decode: ${(e as Error).message}`,
      });
      continue;
    }
    const cb = readComputeBudget(tx);
    const base = BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(tx.numRequiredSignatures);
    const priority = priorityFeeLamports(cb);
    const total = base + priority;
    const observed = BigInt(c.observedFeeLamports);
    cases.push({
      signature: c.signature,
      numRequiredSignatures: tx.numRequiredSignatures,
      unitLimit: cb.unitLimit,
      unitPriceMicroLamports: cb.unitPriceMicroLamports === null ? null : cb.unitPriceMicroLamports.toString(),
      observedFeeLamports: observed.toString(),
      modelBaseFeeLamports: base.toString(),
      modelPriorityFeeLamports: priority.toString(),
      modelTotalFeeLamports: total.toString(),
      feeParity: total === observed,
      executionParity: 'NOT_ESTABLISHABLE_WITHOUT_ARCHIVAL_STATE',
      detail:
        total === observed
          ? 'fee reproduced exactly from the transaction bytes'
          : `fee model says ${total}, the chain charged ${observed}`,
    });
  }
  return {
    protocolVersion: SIMULATION_PROTOCOL_VERSION,
    identity: computeIdentity(REPO_ROOT, { version: runtimeVersion, featureSet }),
    cases,
    allFeesAgree: cases.length > 0 && cases.every((c) => c.feeParity),
    detail:
      'fee parity is established against settled transactions; execution parity is NOT established, because ' +
      'replaying a settled transaction requires the account state at its slot and that requires an archival ' +
      'node this project does not have. SIMULATED_OK therefore does not yet count as confirmatory evidence.',
  };
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((ok, no) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        no(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', no);
  });
}

const server = createServer((req, res) => {
  void (async () => {
    res.setTimeout(REQUEST_TIMEOUT_MS, () => res.destroy());
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/v1/health') {
      // §3.3 — the numbers an operator needs to know whether the mark SLA is
      // survivable, not a liveness bit.
      const oldest = waiting[0];
      send(res, 200, {
        ok: true,
        active,
        queued: waiting.length,
        inFlightJobs: inFlight.size,
        oldestQueueAgeMs: oldest === undefined ? 0 : Date.now() - oldest.enqueuedUtcMs,
        jobsCompleted: jobsRun,
        jobsFailed,
        jobsUnknown,
        medianStartupMs: median(startupSamples),
        medianSimulationMs: median(simulateSamples),
        maxActiveSurfnets: MAX_ACTIVE_SURFNETS,
        queueLimit: MAX_QUEUED,
      });
      return;
    }

    // Everything below needs the local token. Loopback binding stops the LAN;
    // the token stops any other process on this machine.
    if (req.headers['authorization'] !== `Bearer ${TOKEN}`) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url === '/v1/identity') {
      send(res, 200, computeIdentity(REPO_ROOT, { version: runtimeVersion, featureSet }));
      return;
    }

    if (req.method === 'POST' && url === '/v1/parity') {
      let body: ParityRequest;
      try {
        body = JSON.parse(await readBody(req)) as ParityRequest;
      } catch (e) {
        send(res, 400, { error: `bad body: ${(e as Error).message}` });
        return;
      }
      if (body.protocolVersion !== SIMULATION_PROTOCOL_VERSION) {
        send(res, 409, { error: 'protocol version mismatch', expected: SIMULATION_PROTOCOL_VERSION });
        return;
      }
      if (!Array.isArray(body.cases) || body.cases.length === 0) {
        send(res, 400, { error: 'a parity check with no cases proves nothing and is refused' });
        return;
      }
      send(res, 200, runParity(body));
      return;
    }

    if (req.method === 'POST' && url === '/v1/simulate') {
      if (waiting.length >= MAX_QUEUED) {
        send(res, 503, { error: 'queue full', queued: waiting.length, queueLimit: MAX_QUEUED });
        return;
      }
      let parsed: SimulationRequest;
      try {
        parsed = JSON.parse(await readBody(req)) as SimulationRequest;
      } catch (e) {
        send(res, 400, { error: `bad body: ${(e as Error).message}` });
        return;
      }

      if (parsed.protocolVersion !== SIMULATION_PROTOCOL_VERSION) {
        send(res, 409, { error: 'protocol version mismatch', expected: SIMULATION_PROTOCOL_VERSION });
        return;
      }

      // §8 — the same job with the same bytes is idempotent; the same job with
      // DIFFERENT bytes is a caller bug and is refused rather than reconciled.
      const recomputed = computeRequestHash(parsed);
      if (recomputed !== parsed.requestHash) {
        send(res, 400, { error: 'requestHash does not match the request body', recomputed });
        return;
      }
      const prior = completed.get(parsed.jobId);
      if (prior !== undefined) {
        if (prior.requestHash !== parsed.requestHash) {
          send(res, 409, { error: 'jobId reused with a different request hash', priorHash: prior.requestHash });
          return;
        }
        send(res, 200, prior.response);
        return;
      }

      // §3.2 — a request for work already running ATTACHES to it. The hash is
      // checked first: a different hash under a running job id is refused
      // immediately, without waiting for the job it disagrees with.
      const running = inFlight.get(parsed.jobId);
      if (running !== undefined) {
        if (running.requestHash !== parsed.requestHash) {
          send(res, 409, {
            error: 'jobId is in flight with a different request hash',
            priorHash: running.requestHash,
            runningForMs: Date.now() - running.startedUtcMs,
          });
          return;
        }
        try {
          send(res, 200, await running.promise);
        } catch (e) {
          send(res, 200, fail(parsed, 'SIMULATION_UNKNOWN', (e as Error).message.slice(0, 300), Date.now(), 0, 0, 0));
        }
        return;
      }

      const work = (async (): Promise<SimulationResponse> => {
        const slot = await acquireSlot();
        try {
          return await runJob(parsed, slot.queueWaitMs);
        } finally {
          slot.release();
        }
      })();
      inFlight.set(parsed.jobId, { requestHash: parsed.requestHash, promise: work, startedUtcMs: Date.now() });

      try {
        const response = await work;
        completed.set(parsed.jobId, { requestHash: parsed.requestHash, response });
        if (response.status === 'SIMULATION_FAILED') jobsFailed += 1;
        if (response.status === 'SIMULATION_UNKNOWN') jobsUnknown += 1;
        if (response.startupMs > 0) sample(startupSamples, response.startupMs);
        if (response.simulateMs > 0) sample(simulateSamples, response.simulateMs);
        if (completed.size > MAX_CACHED_JOBS) completed.delete(completed.keys().next().value as string);
        send(res, 200, response);
      } catch (e) {
        // The reason is the whole value of a failure. It goes in `detail` and
        // it goes in the log, because a status with no cause is a mystery.
        console.error(JSON.stringify({ msg: 'job threw', jobId: parsed.jobId, error: (e as Error).stack ?? String(e) }));
        jobsUnknown += 1;
        send(res, 200, fail(parsed, 'SIMULATION_UNKNOWN', (e as Error).message.slice(0, 300), Date.now(), 0, 0, 0));
      } finally {
        inFlight.delete(parsed.jobId);
      }
      return;
    }

    send(res, 404, { error: 'no such endpoint' });
  })();
});

await probeRuntime();
server.listen(PORT, HOST, () => {
  const id = computeIdentity(REPO_ROOT, { version: runtimeVersion, featureSet });
  console.log(
    JSON.stringify({
      msg: 'simulatord listening',
      host: HOST,
      port: PORT,
      cwd: REPO_ROOT,
      protocolVersion: id.protocolVersion,
      sourceSha: id.sourceSha,
      surfpool: id.surfpoolPackageVersion,
      runtime: id.runtimeVersion,
      featureSet: id.featureSet,
      binaryHash: id.surfpoolBinaryHash?.slice(0, 16) ?? null,
    }),
  );
});
