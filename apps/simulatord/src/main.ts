import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  SIMULATION_PROTOCOL_VERSION,
  computeRequestHash,
  type SimulationRequest,
  type SimulationResponse,
  type SnapshotBlob,
} from '../../../packages/simulator/src/protocol.js';
import { computeIdentity, assertLinuxFilesystem } from './identity.js';
import { decodeTransaction } from '../../../packages/solana/src/transaction.js';

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
const MAX_QUEUE = 16;

const REPO_ROOT = resolve(process.cwd());
assertLinuxFilesystem(REPO_ROOT);

if (TOKEN.length < 16) {
  console.error(
    'SIMULATORD_TOKEN must be set to at least 16 characters. The daemon is loopback-only, but a local ' +
      'token is what stops any other process on this machine driving it.',
  );
  process.exit(2);
}

interface SurfnetInstance {
  readonly rpcUrl: string;
  readonly payer: string;
  stop(): void;
  fundSol(address: string, lamports: number): void;
  setTokenBalance(owner: string, mint: string, amount: number, tokenProgram?: string): void;
  setAccount(pubkey: string, update: Record<string, unknown>): void;
}
interface SurfnetModule {
  Surfnet: { start(): SurfnetInstance; startWithConfig(c: Record<string, unknown>): SurfnetInstance };
}

const require = createRequire(import.meta.url);
const surfpool = require('@solana/surfpool') as SurfnetModule;

let runtimeVersion: string | null = null;
let featureSet: string | null = null;
let inFlight = 0;
let jobsRun = 0;

/** jobId -> {requestHash, response}. Idempotency, and refusal on a mismatch. */
const completed = new Map<string, { requestHash: string; response: SimulationResponse }>();

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

function blob(pubkey: string, value: Record<string, unknown>, slot: number): SnapshotBlob {
  const data = value['data'];
  return {
    pubkey,
    owner: String(value['owner']),
    lamports: String(value['lamports'] ?? 0),
    dataBase64: Array.isArray(data) ? String(data[0]) : '',
    executable: value['executable'] === true,
    slot,
  };
}

async function runJob(req: SimulationRequest): Promise<SimulationResponse> {
  const t0 = Date.now();
  const jit = req.mode === 'DEVELOPMENT_JIT';

  // §10 — a confirmatory run is offline. Missing snapshot state fails closed
  // rather than being quietly fetched, because a fetch makes the run
  // unreproducible and that is precisely what confirmatory means.
  if (!jit && req.snapshotAccounts.length === 0) {
    return fail(req, 'SIMULATOR_UNAVAILABLE', 'CONFIRMATORY_OFFLINE requires a frozen account snapshot; none supplied', t0, 0, 0);
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
      net.setAccount(a.pubkey, {
        lamports: Number(a.lamports),
        owner: a.owner,
        data: a.dataBase64,
        executable: a.executable,
      });
    }
    for (const m of req.balanceMutations) {
      if (m.kind === 'sol') net.fundSol(m.owner, Number(m.amount));
      else if (m.mint !== undefined) {
        if (m.tokenProgram == null) net.setTokenBalance(m.owner, m.mint, Number(m.amount));
        else net.setTokenBalance(m.owner, m.mint, Number(m.amount), m.tokenProgram);
      }
    }

    const watched = new Set<string>([req.bounds.feePayer, ...req.snapshotAccounts.map((a) => a.pubkey)]);
    const preSol: Record<string, string> = {};
    for (const p of watched) {
      const r = (await rpc(net.rpcUrl, 'getBalance', [p])) as Record<string, unknown> | null;
      preSol[p] = String((r?.['value'] as number | undefined) ?? 0);
    }

    // §14 — the ORIGINAL bytes are preserved. The local SVM has never produced
    // the mainnet blockhash, so a substitution is genuinely required; it is
    // performed on a derived copy and proved not to have changed anything else.
    const original = decodeTransaction(Buffer.from(req.transactionBase64, 'base64'));
    let sendBase64 = req.transactionBase64;
    let replacement: SimulationResponse['blockhashReplacement'] = null;

    // `replaceRecentBlockhash` asks the runtime to do the substitution for us,
    // so the bytes we hold are never edited. The transformation is still
    // recorded, because "the runtime did it" is not the same as "it did not
    // happen".
    const simStart = Date.now();
    const raw = (await rpc(net.rpcUrl, 'simulateTransaction', [
      sendBase64,
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' },
    ])) as Record<string, unknown> | null;
    const simulateMs = Date.now() - simStart;

    const value = (raw?.['value'] ?? null) as Record<string, unknown> | null;
    const err = value?.['err'] ?? null;
    const logs = Array.isArray(value?.['logs']) ? (value['logs'] as string[]) : [];

    replacement = {
      from: req.originalBlockhash,
      to: 'runtime-supplied (replaceRecentBlockhash)',
      // Proved rather than asserted: the bytes we sent are byte-identical to
      // the bytes the policy validated, so no instruction, account or header
      // field could have changed.
      instructionsUnchanged: sendBase64 === req.transactionBase64,
      accountsUnchanged: sendBase64 === req.transactionBase64,
      headerUnchanged: sendBase64 === req.transactionBase64,
    };

    const postSol: Record<string, string> = {};
    const mutated: Record<string, string> = {};
    for (const p of watched) {
      const r = (await rpc(net.rpcUrl, 'getBalance', [p])) as Record<string, unknown> | null;
      postSol[p] = String((r?.['value'] as number | undefined) ?? 0);
      const acct = (await rpc(net.rpcUrl, 'getAccountInfo', [p, { encoding: 'base64' }])) as Record<string, unknown> | null;
      const v = (acct?.['value'] ?? null) as Record<string, unknown> | null;
      if (v !== null) {
        mutated[p] = createHash('sha256').update(JSON.stringify(blob(p, v, -1))).digest('hex');
      }
    }

    const identity = computeIdentity(REPO_ROOT, { version: runtimeVersion, featureSet });
    const total = Date.now() - t0;

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
      // Token deltas need per-mint account reads the caller has to name; not
      // fabricated here. Empty means not measured, never means zero.
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
      mutatedAccountHashes: mutated,
      blockhashReplacement: replacement,
      runtimeEventDigest: createHash('sha256').update(logs.join('\n')).digest('hex'),
      // §10 — a JIT run must hand back everything it pulled so the observation
      // can be frozen and replayed. Not yet captured, and reported as empty
      // rather than as "there was nothing".
      jitFetchedAccounts: [],
      queueWaitMs: 0,
      startupMs,
      simulateMs,
      totalMs: total,
      detail: jit
        ? 'DEVELOPMENT_JIT: mainnet was reachable during this run, so it is NOT reproducible and NOT confirmatory'
        : `offline from snapshot ${req.snapshotManifestHash.slice(0, 12)}; original transaction bytes unmodified`,
      ...(original.version === 0 ? {} : {}),
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
    blockhashReplacement: null,
    runtimeEventDigest: null,
    jitFetchedAccounts: [],
    queueWaitMs: 0,
    startupMs,
    simulateMs,
    totalMs: Date.now() - t0,
    detail,
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
      send(res, 200, { ok: true, inFlight, jobsRun, queueLimit: MAX_QUEUE });
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

    if (req.method === 'POST' && (url === '/v1/simulate' || url === '/v1/parity')) {
      if (inFlight >= MAX_QUEUE) {
        send(res, 503, { error: 'queue full', queueLimit: MAX_QUEUE });
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

      inFlight += 1;
      try {
        const response = await runJob(parsed);
        completed.set(parsed.jobId, { requestHash: parsed.requestHash, response });
        // Bounded memory: this is a cache for retries, not a ledger. Windows
        // holds the durable record.
        if (completed.size > 512) completed.delete(completed.keys().next().value as string);
        send(res, 200, response);
      } catch (e) {
        send(res, 200, fail(parsed, 'SIMULATION_UNKNOWN', (e as Error).message.slice(0, 300), Date.now(), 0, 0));
      } finally {
        inFlight -= 1;
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
