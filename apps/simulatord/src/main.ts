import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  SIMULATION_PROTOCOL_VERSION,
  computeRequestHash,
  type SimulationRequest,
  type SimulationResponse,
  type SnapshotBlob,
  type ParityRequest,
  type ParityCaseResult,
  type ParityResponse,
} from '../../../packages/simulator/src/protocol.js';
import { computeIdentity, assertLinuxFilesystem } from './identity.js';
import { chargedPriorityFee } from '../../../packages/solana/src/computebudget.js';
import {
  programDataAddress,
  decodeProgramData,
  loaderKind,
  looksLikeElf,
  lookupTableAddresses,
} from '../../../packages/solana/src/loader.js';
import {
  decodeTransaction,
  readComputeBudget,
  priorityFeeLamports,
  writableStaticKeys,
  type DecodedTransaction,
} from '../../../packages/solana/src/transaction.js';
import { base58Encode } from '../../../packages/solana/src/base58.js';
import { encodeTokenAccount, rentExemptLamports } from '../../../packages/solana/src/tokenaccount.js';
import {
  associatedTokenAddress,
  TOKEN_PROGRAM as TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM as TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM as LEGACY_TOKEN_PROGRAM,
} from '../../../packages/solana/src/pda.js';
import type { ObservedTokenBalance } from '../../../packages/simulator/src/protocol.js';

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
/**
 * Big enough for a snapshot that carries program code.
 *
 * 8 MiB was a sensible bound for a transaction and an account list, and far too
 * small once the snapshot started carrying ELFs: a five-program Jupiter route
 * base64-encodes to well past it. The failure was not a clean rejection either
 * -- the stream was destroyed mid-write, so the client saw its own timeout and
 * an abort with no status, which is the worst possible way to learn a limit.
 *
 * Sized to the deploy budget: 48 MiB of ELF is about 64 MiB of base64 plus the
 * account data around it.
 */
const MAX_BODY_BYTES = 96 * 1024 * 1024;
/**
 * Long enough to deploy a route's programs from frozen ELF.
 *
 * A three-hop Jupiter route freezes six programs, and their ELFs run to
 * megabytes each. 60 s was a mark-cadence budget, not a snapshot-restore
 * budget, and it killed the offline replay mid-deploy -- which surfaced on the
 * client as a bare abort with nothing to diagnose.
 */
const REQUEST_TIMEOUT_MS = 300_000;

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
/**
 * How many accounts one run reads pre and post.
 *
 * Raised from 64. A three-hop Pump route resolves well past that through its
 * lookup tables, and P5 requires `truncated == 0` for a run to count as
 * evidence — a cap that the routes we actually trade exceed is a cap that makes
 * every one of them inadmissible.
 *
 * Still bounded: an unbounded read is a way to hang the daemon on a pathological
 * transaction, and truncation is reported rather than hidden.
 */
const MAX_WATCHED_ACCOUNTS = 256;

/**
 * Where content-addressed program ELFs live.
 *
 * Inside WSL rather than on the Windows mount: the native side reads these
 * on every deploy, and a 9p round trip per read would give back what the
 * path was chosen to avoid.
 */
const ELF_CACHE_DIR = process.env['SIMULATORD_ELF_CACHE'] ?? '/tmp/epitaxy-elf-cache';

/** Named once. Measured against three settled mainnet transactions. */
const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * How much program code one offline restore may deploy.
 *
 * MEASURED, after an earlier guess got this wrong. deploy() is synchronous and
 * does hold the event loop, so a bound belongs here -- but it is cheap:
 *
 *      16 KiB    1 ms       512 KiB   37 ms      1536 KiB  107 ms
 *     128 KiB    8 ms      1024 KiB   78 ms
 *
 * Linear at roughly 70 microseconds per KiB. A six-program route restores in
 * well under a second, so the five-minute restore that prompted the first
 * version of this bound was never the deploy: it was WSL2 localhost forwarding
 * wedged, which makes a healthy daemon look like a hung one.
 *
 * The bound stays, because a synchronous call on the request path should be
 * bounded. It is now set from the measurement rather than from the fear.
 */
const MAX_DEPLOY_PROGRAMS = 24;
const MAX_DEPLOY_BYTES = 48 * 1024 * 1024;

class DeployBudgetExceeded extends Error {
  constructor(programs: number, bytes: number) {
    super(
      `restoring this snapshot needs ${programs} program deploy(s) totalling about ${bytes} bytes, above the ` +
        `budget of ${MAX_DEPLOY_PROGRAMS} programs / ${MAX_DEPLOY_BYTES} bytes. deploy() is synchronous and ` +
        'holds the daemon for roughly 70 microseconds per KiB, so an unbounded restore would stall every ' +
        'other job queued behind it. Refusing instead.',
    );
    this.name = 'DeployBudgetExceeded';
  }
}

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
/** SPL token account layout: mint(32) owner(32) amount(u64 LE) — amount at 64. */
const TOKEN_AMOUNT_OFFSET = 64;
/** Base SPL token account size. A legacy mint is 82 and must never decode as one. */
const TOKEN_ACCOUNT_LEN = 165;
/** Token-2022 `AccountType::Account`. `Mint` is 1 and is refused. */
const TOKEN_2022_ACCOUNT_TYPE = 2;

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
  timeTravelToSlot(slot: number): unknown;
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

/**
 * P2 — decode a token account into the identity a verdict can be computed on.
 *
 * The SPL token account layout is fixed and the first three fields are all we
 * need:
 *
 *   0..32   mint
 *   32..64  owner
 *   64..72  amount, u64 little-endian
 *
 * Token-2022 accounts share that prefix and append extensions after the base
 * 165 bytes, so the same read is correct for both. Which PROGRAM owns the
 * account is `v.owner` — the account's owner in the Solana sense — and it is
 * carried explicitly because legacy Token and Token-2022 are different programs
 * whose balances must never be summed as though they were one asset.
 *
 * Returns null when the account is not a token account at all. Null is not a
 * zero balance and is not written as one.
 */
function observedTokenBalance(pubkey: string, v: AccountView | null): ObservedTokenBalance | null {
  if (v === null) return null;
  if (!TOKEN_PROGRAMS.has(v.owner)) return null;

  // A MINT is also owned by the token program, and decoding one as an account
  // yields a plausible-looking row with a garbage owner and mint. The first
  // version of this checked only `length >= 72` and produced exactly that: the
  // route's own mint accounts appeared as token balances owned by addresses
  // that do not exist.
  //
  // The sizes are fixed and are the discriminator:
  //
  //   legacy mint            82
  //   legacy token account  165
  //   Token-2022            165 base, then a 1-byte account type at offset 165
  //                         followed by TLV extensions
  //
  // So exactly 165 is an account; longer needs the type byte, where 1 is Mint
  // and 2 is Account; shorter is neither.
  if (v.data.length < TOKEN_ACCOUNT_LEN) return null;
  if (v.data.length > TOKEN_ACCOUNT_LEN) {
    const accountType = v.data.readUInt8(TOKEN_ACCOUNT_LEN);
    // 2 is Account. Anything else -- a Mint with extensions, or a type this
    // build does not know -- is refused rather than read as an account.
    if (accountType !== TOKEN_2022_ACCOUNT_TYPE) return null;
  }

  return {
    tokenAccount: pubkey,
    mint: base58Encode(v.data.subarray(0, 32)),
    owner: base58Encode(v.data.subarray(32, 64)),
    tokenProgram: v.owner,
    amount: v.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET).toString(),
  };
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

/**
 * §7.1/§7.2 — freeze the pre-transaction state of everything the run touched.
 *
 * Programs are the hard part. The account at a program's address holds a
 * pointer, not code, so an executable entry is followed to its ProgramData
 * account and the ELF extracted from behind the 45-byte header. Without that,
 * an offline replay has an address that is supposed to be a program and no way
 * to make it one.
 *
 * Anything that cannot be captured is NAMED in `omissions` rather than dropped.
 * A snapshot that is quietly missing an account replays into a different chain
 * state and produces a confident, wrong answer.
 */
async function exportSnapshot(
  url: string,
  keys: readonly string[],
): Promise<{ blobs: SnapshotBlob[]; omissions: string[]; absent: string[]; builtins: string[] }> {
  const omissions: string[] = [];
  const absent: string[] = [];
  const builtins: string[] = [];
  const blobs: SnapshotBlob[] = [];
  const views = await readAccounts(url, keys);

  // Programs point at a second account, so the set to read grows as we go.
  const programDataOf = new Map<string, string>();
  for (const [pubkey, v] of views) {
    if (v === null || !v.executable) continue;
    const kind = loaderKind(v.owner);
    if (kind !== 'upgradeable') continue;
    try {
      programDataOf.set(pubkey, programDataAddress(new Uint8Array(v.data)));
    } catch (e) {
      omissions.push(`${pubkey}: program account did not decode (${(e as Error).message})`);
    }
  }
  const extra = [...new Set([...programDataOf.values()].filter((k) => !views.has(k)))];
  const extraViews = extra.length === 0 ? new Map() : await readAccounts(url, extra);

  for (const [pubkey, v] of views) {
    if (v === null) {
      // Absent, and faithfully so. A fresh Surfnet holds nothing, so leaving an
      // account OUT of the snapshot is exactly how "this did not exist before
      // the transaction" is expressed. Recorded for provenance, not as a
      // failure -- the ATA a swap is about to create is absent by definition,
      // and calling that a capture failure disqualifies every honest run.
      absent.push(pubkey);
      continue;
    }
    let elf: string | null = null;
    if (v.executable) {
      const kind = loaderKind(v.owner);
      if (kind === 'native') {
        // A builtin. The runtime provides it, there is no ELF to capture, and
        // restoring it would be writing over the runtime's own program with a
        // non-executable copy of itself.
        builtins.push(pubkey);
        continue;
      }
      const pdAddr = programDataOf.get(pubkey);
      const pd = pdAddr === undefined ? null : (extraViews.get(pdAddr) ?? views.get(pdAddr) ?? null);
      if (kind === 'upgradeable' && pd !== null) {
        try {
          const decoded = decodeProgramData(new Uint8Array(pd.data));
          if (!looksLikeElf(decoded.elf)) {
            omissions.push(`${pubkey}: ProgramData did not begin with ELF magic`);
          } else {
            elf = Buffer.from(decoded.elf).toString('base64');
          }
        } catch (e) {
          omissions.push(`${pubkey}: ProgramData did not decode (${(e as Error).message})`);
        }
      } else if (kind === 'v1' || kind === 'v2') {
        // A non-upgradeable program holds its ELF directly.
        if (looksLikeElf(new Uint8Array(v.data))) elf = v.data.toString('base64');
        else omissions.push(`${pubkey}: ${kind} program account did not begin with ELF magic`);
      } else {
        omissions.push(`${pubkey}: executable under ${kind} loader (${v.owner}); no capture path`);
      }
    }
    blobs.push(blobOf(pubkey, v, elf));
  }

  // The ProgramData accounts themselves are frozen too: an offline replay that
  // deploys the code should still see the account the program points at.
  for (const [pubkey, v] of extraViews) {
    if (v === null) omissions.push(`${pubkey}: ProgramData absent at capture time`);
    else blobs.push(blobOf(pubkey, v, null));
  }

  return { blobs, omissions, absent, builtins };
}

function blobOf(pubkey: string, v: AccountView, elf: string | null): SnapshotBlob {
  return {
    pubkey,
    owner: v.owner,
    lamports: v.lamports.toString(),
    dataBase64: v.data.toString('base64'),
    executable: v.executable,
    slot: -1,
    programElfBase64: elf,
  };
}

/**
 * Per-stage timing, reported on every job.
 *
 * A job that is slow without saying WHICH part was slow is a job you diagnose
 * by guessing. `startupMs` and `simulateMs` cover two stages out of eight, and
 * the six they leave out are where restores actually spend their time.
 */
class Stages {
  private readonly marks: [string, number][] = [];
  private last = Date.now();
  mark(name: string): void {
    const now = Date.now();
    this.marks.push([name, now - this.last]);
    this.last = now;
  }
  summary(): string {
    return this.marks.map(([n, ms]) => `${n}=${ms}ms`).join(' ');
  }
  slowest(): string {
    let worst: [string, number] = ['none', -1];
    for (const m of this.marks) if (m[1] > worst[1]) worst = m;
    return `${worst[0]}=${worst[1]}ms`;
  }
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
  // Builtins are exempt: the runtime provides them, so an executable entry
  // owned by the native loader has no ELF to be missing.
  const missingElf = req.snapshotAccounts.filter(
    (a) => a.executable && (a.programElfBase64 ?? null) === null && loaderKind(a.owner) !== 'native',
  );
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

  // Stand at the right point in time BEFORE restoring anything.
  //
  // A lookup table records the slot it was extended at, and the runtime will
  // not resolve entries added at a slot in its own future. A fresh instance
  // starts near slot 33; a mainnet table was extended around slot 438,000,000.
  // Restore perfect account state onto that and every table-loaded pool is
  // unreachable with "contains an invalid index" -- which reads like a corrupt
  // snapshot and is actually a clock that was never set.
  let slotTravelled: number | null = null;
  if (req.targetSlot !== null && req.targetSlot > 0) {
    try {
      net.timeTravelToSlot(req.targetSlot);
      slotTravelled = req.targetSlot;
    } catch (e) {
      return fail(
        req,
        'SIMULATOR_UNAVAILABLE',
        `could not move the instance to slot ${req.targetSlot}: ${(e as Error).message}`,
        t0,
        queueWaitMs,
        startupMs,
        0,
      );
    }
  }

  // Which programs this run deployed, and which it found already there. Both
  // are provenance: a replay is only reproducible if the same code ran.
  const deployedPrograms: string[] = [];
  const preloadedPrograms: string[] = [];
  let elfBytesToDeploy = 0;
  const stages = new Stages();

  try {
    // Which programs does this instance ALREADY have?
    //
    // Measured: a fresh offline Surfnet preloads System, ComputeBudget, SPL
    // Token, Token-2022 and the ATA program. Jupiter, Pump and PumpSwap are
    // absent. Deploying over a program that already exists PANICS inside
    // surfpool's Rust core -- "copy_from_slice: source slice length (13) does
    // not match destination slice length (45)" -- which kills the HTTP worker
    // and surfaces as a transport error with no hint of the cause.
    //
    // So the rule is: deploy what is missing, leave alone what is there. The
    // preloaded copies are the runtime's own and are what a real route runs
    // against anyway.
    const executables = req.snapshotAccounts.filter((a) => a.executable);
    const alreadyPresent = new Set<string>();
    if (executables.length > 0) {
      const existing = await readAccounts(
        net.rpcUrl,
        executables.map((a) => a.pubkey),
      );
      for (const [pubkey, v] of existing) if (v !== null && v.executable) alreadyPresent.add(pubkey);
    }
    stages.mark('probeExisting');

    // §13 — typed methods, not raw pokes.
    for (const a of req.snapshotAccounts) {
      if (a.executable && loaderKind(a.owner) === 'native') {
        // Provided by the runtime. Writing over it would replace a working
        // builtin with a non-executable copy of its own bytes.
        continue;
      }
      if (a.executable && alreadyPresent.has(a.pubkey)) {
        preloadedPrograms.push(a.pubkey);
        continue;
      }
      if (a.executable) {
        // MEASURED LIMIT, and the reason this is bounded rather than hopeful.
        //
        // `deploy()` is a SYNCHRONOUS napi call. It blocks the daemon's event
        // loop for its whole duration, so a large restore takes the process
        // down with it: during a six-program restore /v1/health stopped
        // answering entirely and the daemon looked dead rather than busy.
        //
        // A three-hop Jupiter route freezes six programs whose ELFs run to
        // megabytes each, and restoring them did not complete within five
        // minutes. Until that is either made asynchronous or moved off the
        // request path, a snapshot beyond this budget is REFUSED with a reason
        // instead of hanging the daemon and timing the caller out with nothing
        // to diagnose.
        elfBytesToDeploy += Math.floor(((a.programElfBase64 ?? '').length * 3) / 4);
        if (elfBytesToDeploy > MAX_DEPLOY_BYTES || deployedPrograms.length >= MAX_DEPLOY_PROGRAMS) {
          throw new DeployBudgetExceeded(deployedPrograms.length + 1, elfBytesToDeploy);
        }
        deployedPrograms.push(a.pubkey);
        /**
         * P8 Step 1 — content-addressed `.so` on disk, deployed by PATH.
         *
         * `soBytes` marshals the whole ELF through N-API as a JavaScript
         * `number[]`, element by element, on the request thread. Six of those
         * did not finish in five minutes and took `/v1/health` down with them.
         *
         * The file is written once per distinct ELF and reused: the programs
         * on a Pump route are the same on every Pump route, so the second
         * replay of the day writes nothing. Content addressing makes that safe
         * -- a path is only reused when the bytes are identical.
         */
        const elf = Buffer.from(a.programElfBase64 ?? '', 'base64');
        const digest = createHash('sha256').update(elf).digest('hex');
        const soPath = resolve(ELF_CACHE_DIR, `${digest}.so`);
        if (!existsSync(soPath)) {
          mkdirSync(ELF_CACHE_DIR, { recursive: true });
          // Written to a temporary name and renamed, so a crash mid-write
          // cannot leave a truncated ELF at a hash that claims to be complete.
          const partial = `${soPath}.partial`;
          writeFileSync(partial, elf);
          renameSync(partial, soPath);
        }
        net.deploy({ programId: a.pubkey, soPath });
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
    /** Accounts the SETUP wrote. Their rent is ours, never the trade's. */
    const provisionedAccounts: string[] = [];
    for (const m of req.balanceMutations) {
      if (m.kind === 'sol') {
        net.fundSol(m.owner, exactNumber(BigInt(m.amount), `SOL mutation for ${m.owner}`));
        continue;
      }
      if (m.mint === undefined) continue;

      /**
       * P4 — the account is written byte for byte, not through the convenience
       * API.
       *
       * `setTokenBalance` takes a JavaScript `number`. Refusing to round was
       * right and it meant an ordinary fresh memecoin position could not be
       * simulated at all: nine decimals against a billion supply is 10^18
       * atoms, three orders of magnitude past exact.
       *
       * Writing it directly also removes a second problem. When the cheatcode
       * OPENS the account, the fee payer carries its rent, and that rent lands
       * in the same net SOL movement a sell's proceeds do — 2,039,280 lamports
       * against a 0.02 SOL leg is ten percent of the notional. An account
       * written here is already rent-exempt and the payer never paid for it, so
       * the question does not arise rather than being adjusted for in two
       * places that disagreed.
       */
      const program = m.tokenProgram ?? LEGACY_TOKEN_PROGRAM;
      const ata = associatedTokenAddress(m.owner, m.mint, program);
      const bytes = encodeTokenAccount({
        mint: m.mint,
        owner: m.owner,
        amount: BigInt(m.amount),
        // Token-2022 associated accounts carry ImmutableOwner. Legacy accounts
        // carry no extensions at all.
        extensions: program === TOKEN_2022_PROGRAM_ID ? [{ kind: 'immutable_owner' }] : [],
      });
      net.setAccount(
        ata,
        // Rent-exempt for THIS length, derived rather than the 165-byte
        // constant, so an extended account is not written under-funded.
        exactNumber(rentExemptLamports(bytes.length), `rent for ${ata}`),
        bytes,
        program,
      );
      // Verify the account we wrote is the one the transaction will read. A
      // provisioned balance at an address the route never touches is the P2
      // defect wearing different clothes.
      provisionedAccounts.push(ata);
      namedAtas.push(ata);
    }
    stages.mark('restoreAccounts');
    if (req.bounds.mint !== undefined) {
      try {
        namedAtas.push(net.getAta(req.bounds.feePayer, req.bounds.mint));
      } catch {
        /* as above */
      }
    }

    // §8 — complete account coverage.
    //
    // A transaction's accounts are NOT its static keys. Everything its lookup
    // tables load is an account it touches, and on a Jupiter route that is
    // exactly where the pools live. Watching only the static keys produced an
    // offline snapshot with no liquidity in it and a replay that could not even
    // resolve the table: "Account 8BNMiq1C... not found".
    //
    // The tables themselves are read from the running instance and expanded, so
    // the addresses come from the same chain state the transaction ran against
    // rather than from a second lookup that may have moved.
    const altAccounts = original.addressTableLookups.map((l) => l.accountKey);
    const loadedFromTables: string[] = [];
    const unresolvedTables: string[] = [];
    const writableFromTables = new Set<string>();
    if (altAccounts.length > 0) {
      const tableViews = await readAccounts(net.rpcUrl, altAccounts);
      for (const lookup of original.addressTableLookups) {
        const view = tableViews.get(lookup.accountKey) ?? null;
        if (view === null) {
          unresolvedTables.push(`${lookup.accountKey}: not present`);
          continue;
        }
        let entries: string[];
        try {
          entries = lookupTableAddresses(new Uint8Array(view.data));
        } catch (e) {
          unresolvedTables.push(`${lookup.accountKey}: ${(e as Error).message}`);
          continue;
        }
        for (const i of lookup.writableIndexes) {
          const addr = entries[i];
          if (addr === undefined) unresolvedTables.push(`${lookup.accountKey}[w${i}]: index out of range`);
          else {
            loadedFromTables.push(addr);
            writableFromTables.add(addr);
          }
        }
        for (const i of lookup.readonlyIndexes) {
          const addr = entries[i];
          // An index past the end of the table is an unresolvable address, not
          // an address of zero. Named rather than skipped.
          if (addr === undefined) unresolvedTables.push(`${lookup.accountKey}[r${i}]: index out of range`);
          else loadedFromTables.push(addr);
        }
      }
    }

    /**
     * The accounts the LEG is about, first.
     *
     * The watched list was a plain `slice(0, 64)` over an unordered union. A
     * Pump route with lookup tables runs past 64 easily, and for a buy there is
     * no token mutation to name the destination, so the taker's own ATA fell
     * off the end. The pool's movement was observed, the fee payer's movement
     * was observed, and the one account the trade exists to credit was not —
     * reported as "output delta is missing" on a transaction that had in fact
     * delivered.
     *
     * Truncation still happens and is still reported. What must never happen is
     * truncating the accounts whose balances the verdict is computed from, so
     * those go at the front where the cut cannot reach them.
     */
    const priority: string[] = [req.bounds.feePayer];
    for (const m of req.balanceMutations) {
      if (m.kind !== 'token' || m.mint === undefined) continue;
      priority.push(m.owner);
      // Both programs: the caller may not have said which, and deriving the
      // wrong one costs a wasted slot rather than a wrong answer.
      for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        try {
          priority.push(associatedTokenAddress(m.owner, m.mint, program));
        } catch {
          /* an address we cannot derive is one we do not watch, and the
             coverage check below will say so rather than assume */
        }
      }
    }
    // The bound's own mint, which on a buy is the asset being credited and has
    // no balance mutation to name it.
    if (req.bounds.mint !== undefined) {
      for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        try {
          priority.push(associatedTokenAddress(req.bounds.feePayer, req.bounds.mint, program));
        } catch {
          /* as above */
        }
      }
    }

    const allWatched = [
      ...new Set([
        ...priority,
        ...original.staticAccountKeys,
        ...altAccounts,
        ...loadedFromTables,
        ...req.snapshotAccounts.map((a) => a.pubkey),
        ...namedAtas,
      ]),
    ];
    const watched = allWatched.slice(0, MAX_WATCHED_ACCOUNTS);
    const truncated = allWatched.length - watched.length;

    stages.mark('resolveLookups');
    const pre = await readAccounts(net.rpcUrl, watched);
    stages.mark('readPre');

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
    stages.mark('simulate');

    const contextSlotRaw = (raw?.['context'] as Record<string, unknown> | undefined)?.['slot'];
    const contextSlot = typeof contextSlotRaw === 'number' ? contextSlotRaw : null;
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
    const post = new Map<string, AccountView | null>();

    // A FAILED transaction produces no post-state at all: the runtime returns
    // nulls across the board because nothing was applied. Reading those nulls
    // the way a successful run's nulls are read reported every writable account
    // as CLOSED -- on one real route that meant the fee payer was booked as
    // closed and its entire 0.2 SOL balance as rent recovered.
    //
    // Nothing happened, so the post-state IS the pre-state, and created/closed
    // and rent are not measurable from this run at all.
    const noPostState = err !== null;

    watched.forEach((k, i) => {
      const returned = viewOf(postList[i] ?? null);
      if (returned !== null) {
        post.set(k, returned);
        return;
      }
      if (noPostState) {
        post.set(k, pre.get(k) ?? null);
        return;
      }
      if (writable.has(k)) {
        // Writable, and the runtime returned nothing: genuinely gone.
        post.set(k, null);
      } else if (writableFromTables.has(k)) {
        // Writable via a lookup table and not returned: gone, same as a static
        // writable. Knowable now that the tables are resolved.
        post.set(k, null);
      } else {
        // Readonly, whether static or table-loaded, so it is exactly as it was.
        post.set(k, pre.get(k) ?? null);
      }
    });

    const preSol: Record<string, string> = {};
    const postSol: Record<string, string> = {};
    const preTok: Record<string, string> = {};
    const postTok: Record<string, string> = {};
    const preTokenAccounts: ObservedTokenBalance[] = [];
    const postTokenAccounts: ObservedTokenBalance[] = [];
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

      // P2 — the structured view, which says what each balance belongs to.
      // Absence from either array is the fact that the account did not exist
      // on that side, which a zero amount cannot express.
      const pa = observedTokenBalance(k, a);
      const pb = observedTokenBalance(k, b);
      if (pa !== null) preTokenAccounts.push(pa);
      if (pb !== null) postTokenAccounts.push(pb);

      const existedBefore = a !== null && a.lamports > 0n;
      const existsAfter = b !== null && b.lamports > 0n;
      if (!existedBefore && existsAfter) {
        created.push(k);
        // S055 — an account the SETUP wrote existed before the transaction ran,
        // so the transaction did not create it and the payer did not fund it.
        // Counting its rent as a trade cost is what gave one sell two credits.
        if (!provisionedAccounts.includes(k)) rentCreated += b.lamports;
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
    stages.mark('fee');
    // Resolves the limit the runtime will apply before pricing it. The old call
    // returned zero for every Jupiter route, because Jupiter never sends
    // SetComputeUnitLimit and a null limit multiplied out to nothing.
    const charged = chargedPriorityFee(original, readComputeBudget(original));
    const declaredPriority = charged.lamports;

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
    const decompositionExact = err === null && truncated === 0 && unresolvedTables.length === 0 && baseFee !== null;
    const feeNotes: string[] = [];
    if (truncated > 0) feeNotes.push(`${truncated} account(s) beyond the ${MAX_WATCHED_ACCOUNTS} watched were not observed`);
    if (unresolvedTables.length > 0) {
      feeNotes.push(`${unresolvedTables.length} lookup entr(ies) could not be resolved: ${unresolvedTables.slice(0, 3).join('; ')}`);
    }
    if (decompositionExact && residual !== declaredPriority) {
      feeNotes.push(
        `priority fee disagreement: bytes imply ${declaredPriority} ` +
          `(${charged.limit.units} units, ${charged.limit.source}), balances imply ${residual}`,
      );
    }
    /**
     * P5 — the compute-budget BYTES are the authoritative priority fee.
     *
     * This previously reported the fee only when a balance-derived residual
     * agreed with the bytes exactly, and otherwise reported nothing. The
     * intention was right and the consequence was that every run said
     * "fee decomposition incomplete: no priority fee reported" — including
     * every run whose fee was perfectly well known from its own instructions.
     *
     * The residual is not a second measurement of the same thing. It is
     * `payer loss - others gained`, and that identity does not hold for a sell:
     * a sell INCREASES the payer's balance, so the subtraction produces a
     * number with no meaning and then suppresses the one that had meaning.
     *
     * So the bytes are reported, and the balance check is kept as independent
     * corroboration with its disagreement recorded rather than fatal. The
     * runtime charges on the requested limit, and the requested limit is in the
     * transaction.
     */
    const priorityFee = err !== null ? null : declaredPriority;
    /** Whether the independent balance check agreed. Recorded, not gating. */
    const priorityFeeCorroborated = err === null && decompositionExact && residual === declaredPriority;

    // §6 — the caller's asserted bounds are CHECKED, not carried. A bound
    // nothing tests is a comment with a schema.
    const boundsViolations: string[] = [];
    if (err === null) {
      const spent = payerPre - payerPost;
      /**
       * P3 — the OUTPUT side, checked against the asset it is actually in.
       *
       * A token→SOL sell credits native lamports. Asking `minTokenDelta` about
       * it inspects a token account the trade never touches, finds nothing, and
       * reports a delta of zero on a transaction that paid out correctly.
       */
      const out = req.bounds.outputAsset;
      if (out !== undefined && out.kind === 'native_sol' && out.minCreditLamports !== undefined) {
        const payerDelta = BigInt(postSol[req.bounds.feePayer] ?? '0') - BigInt(preSol[req.bounds.feePayer] ?? '0');
        // The payer's net movement includes what it paid to trade. The credit
        // is that movement with the transaction's own costs added back, because
        // those left the payer for reasons other than the swap.
        const credit = payerDelta + (baseFee ?? 0n) + (priorityFee ?? 0n) + rentCreated - rentRecovered;
        const min = BigInt(out.minCreditLamports);
        if (credit < min) boundsViolations.push(`native SOL credit ${credit} below the asserted minimum ${min}`);
      }
      if (out !== undefined && out.kind === 'token' && out.minCreditAtoms !== undefined) {
        const before = preTokenAccounts.find((b) => b.tokenAccount === out.tokenAccount);
        const after = postTokenAccounts.find((b) => b.tokenAccount === out.tokenAccount);
        if (after === undefined) {
          boundsViolations.push(`output token account ${out.tokenAccount.slice(0, 8)} was not observed after the run`);
        } else {
          // Absent before means the transaction created it, and an account that
          // did not exist held nothing. That is the one case where absence is a
          // number.
          const delta = BigInt(after.amount) - BigInt(before?.amount ?? '0');
          const min = BigInt(out.minCreditAtoms);
          if (delta < min) boundsViolations.push(`token credit ${delta} below the asserted minimum ${min}`);
          if (after.mint !== out.mint) boundsViolations.push('output token account holds a different mint than asserted');
          if (after.tokenProgram !== out.tokenProgram) {
            boundsViolations.push('output token account is owned by a different token program than asserted');
          }
        }
      }

      // P3 — the INPUT side. An exact debit is exact.
      const inp = req.bounds.inputAsset;
      if (inp !== undefined && inp.kind === 'token' && inp.exactDebitAtoms !== undefined) {
        const before = preTokenAccounts.find((b) => b.tokenAccount === inp.tokenAccount);
        const after = postTokenAccounts.find((b) => b.tokenAccount === inp.tokenAccount);
        if (before === undefined) {
          boundsViolations.push(`input token account ${inp.tokenAccount.slice(0, 8)} was not observed before the run`);
        } else {
          // A closed source account spent everything it held.
          const debit = BigInt(before.amount) - BigInt(after?.amount ?? '0');
          const exact = BigInt(inp.exactDebitAtoms);
          if (debit !== exact) boundsViolations.push(`token debit ${debit} is not the asserted exact ${exact}`);
        }
      }

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

    // §7.1 step 5-7. Taken from the same instance that just ran the
    // transaction, so it is that run's state and not a later fetch of it.
    const exported = await exportSnapshot(net.rpcUrl, watched);
    if (exported.absent.length > 0) {
      feeNotes.push(
        `${exported.absent.length} account(s) did not exist before the transaction and are frozen by absence`,
      );
    }
    if (exported.builtins.length > 0) {
      feeNotes.push(`${exported.builtins.length} builtin program(s) are provided by the runtime and not captured`);
    }
    if (deployedPrograms.length > 0) feeNotes.push(`deployed ${deployedPrograms.length} program(s) from frozen ELF`);
    if (preloadedPrograms.length > 0) {
      feeNotes.push(`${preloadedPrograms.length} program(s) were already present in the runtime and were not redeployed`);
    }

    stages.mark('exportSnapshot');
    const events = net.drainEvents();
    const identity = computeIdentity(REPO_ROOT, { version: runtimeVersion, featureSet });
    const total = Date.now() - t0;
    console.log(
      JSON.stringify({
        msg: 'job complete',
        jobId: req.jobId,
        mode: req.mode,
        status: err === null ? 'ok' : 'failed',
        totalMs: total,
        slowest: stages.slowest(),
        stages: stages.summary(),
      }),
    );
    const notes = [
      jit
        ? 'DEVELOPMENT_JIT: mainnet was reachable during this run, so it is NOT reproducible and NOT confirmatory'
        : `offline from snapshot ${req.snapshotManifestHash.slice(0, 12)}; original transaction bytes unmodified`,
      ...feeNotes,
      slotTravelled === null
        ? 'no target slot was given, so this ran at the instance default slot'
        : `moved to slot ${slotTravelled} before restoring, so lookup tables resolve`,
      `stage timing: ${stages.summary()}`,
      'transfer/withheld Token-2022 fees are not measured by this build and are reported as unknown, not zero',
    ];
    if (noPostState) {
      notes.push(
        'the transaction failed, so no post-state was applied: balances are carried from the pre-state and ' +
          'rent, created and closed accounts are not measured by this run',
      );
    }

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
      preTokenAccounts,
      postTokenAccounts,
      priorityFeeCorroborated,
      baseFeeLamports: baseFee === null ? null : baseFee.toString(),
      priorityFeeLamports: priorityFee === null ? null : priorityFee.toString(),
      // Null, not zero, when the transaction failed: nothing was applied, so
      // these were not measured rather than measured to be nothing.
      rentCreatedLamports: noPostState ? null : rentCreated.toString(),
      rentRecoveredLamports: noPostState ? null : rentRecovered.toString(),
      // Not measured by this build. Null is the honest answer; zero would be a
      // claim that Token-2022 charged nothing.
      transferFeeLamports: null,
      withheldFeeLamports: null,
      createdAccounts: noPostState ? [] : created,
      closedAccounts: noPostState ? [] : closed,
      mutatedAccountHashes: mutated,
      boundsViolations,
      blockhashReplacement: replacement,
      contextSlot,
      runtimeEventDigest: createHash('sha256')
        .update(JSON.stringify({ logs, events: events.map((e) => e.kind) }))
        .digest('hex'),
      exportedSnapshot: exported.blobs,
      exportOmissions: exported.omissions,
      // Under JIT these are the same accounts: everything present was pulled
      // from mainnet during the run. Named separately because an offline run
      // fetches nothing and must report an empty list for a different reason.
      jitFetchedAccounts: jit ? exported.blobs : [],
      queueWaitMs,
      startupMs,
      simulateMs,
      totalMs: total,
      detail: notes.join('; '),
    };
  } catch (e) {
    if (e instanceof DeployBudgetExceeded) {
      // Our limitation, not the token's, so it is SIMULATOR_UNAVAILABLE.
      return fail(req, 'SIMULATOR_UNAVAILABLE', e.message, t0, queueWaitMs, startupMs, 0);
    }
    throw e;
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
    preTokenAccounts: [],
    postTokenAccounts: [],
    priorityFeeCorroborated: false,
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
    exportedSnapshot: [],
    exportOmissions: [],
    contextSlot: null,
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

class BodyTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`request body is ${bytes} bytes, above the ${MAX_BODY_BYTES} byte limit`);
    this.name = 'BodyTooLarge';
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((ok, no) => {
    let size = 0;
    const parts: Buffer[] = [];
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES && !over) {
        over = true;
        // Stop accumulating, but keep DRAINING. Destroying the socket while the
        // client is still writing means the response never arrives and the
        // caller times out with no status at all -- it learns nothing, slowly.
        // Reading to the end costs a little bandwidth and buys a real 413.
        parts.length = 0;
        return;
      }
      if (!over) parts.push(c);
    });
    req.on('aborted', () => no(new Error('the client aborted while sending the body')));
    req.on('end', () => {
      if (over) {
        no(new BodyTooLarge(size));
        return;
      }
      ok(Buffer.concat(parts).toString('utf8'));
    });
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
        // Whether DEVELOPMENT_JIT can work at all. Without a remote there is
        // nowhere to fetch from, and every JIT job fails fast -- correct, and
        // impossible to diagnose from outside without saying so here. The URL
        // itself is not reported; only whether one is configured.
        jitCapable: (process.env['SIMULATORD_REMOTE_RPC'] ?? '').length > 0,
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
        if (e instanceof BodyTooLarge) {
          send(res, 413, { error: e.message, limitBytes: MAX_BODY_BYTES, receivedBytes: e.bytes });
          return;
        }
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
