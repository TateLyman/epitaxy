/**
 * `tsx scripts/sqd-backfill.ts` — pull PumpSwap (`pump_amm`) history out of the
 * free SQD Portal into newline-delimited JSON under `data/sqd/`.
 *
 * The endpoint is `portal.sqd.dev/datasets/solana-mainnet/finalized-stream`. No
 * API key, no account, no signup. It answers a server-side Anchor discriminator
 * filter, which is the whole reason this is affordable: the filter runs on their
 * side, so we pay bytes only for pump_amm instructions and not for the ~50,000
 * other instructions in each Solana block.
 *
 * ---------------------------------------------------------------------------
 * WHAT WE ASK FOR, AND WHY — this is the decision-bearing part of the file
 * ---------------------------------------------------------------------------
 *
 * The obvious query is "give me the `buy` and `sell` instructions". It is wrong,
 * and cheaply so. The outer `buy`/`sell` instruction data carries only the call
 * arguments (`base_amount_out`, `max_quote_amount_in`). It does NOT carry the
 * pool, the trader, the reserves, or the fee ladder. Those live in two other
 * places, and the choice between them is a 1.7x difference in bytes and a much
 * larger difference in what the corpus can answer:
 *
 *   (a) `instruction.accounts` on the outer buy/sell. Gives the account list,
 *       so `accounts[0]` is the pool and `accounts[1]` is the user. MEASURED at
 *       slot 370,000,000 over 31 slots / 1,526 instructions:
 *         no accounts   104.8 B/instruction
 *         with accounts 1,129.5 B/instruction      <- 10.8x
 *       It buys two pubkeys for ~1,025 bytes, and still yields no reserves and
 *       no fees. This reproduces the reported "a week goes from 3.5 GB to
 *       ~100 GB" blow-up: it is real, it is ~10x, and it is a bad trade.
 *
 *   (b) The Anchor `emit_cpi!` self-CPI instruction. pump_amm emits its events
 *       as an inner instruction to itself whose data is
 *       `e445a52e51cb9a1d || <event discriminator> || <borsh payload>`. Filtering
 *       `d8 = 0xe445a52e51cb9a1d` on the same program returns those directly.
 *       MEASURED over the same 31 slots / 1,530 instructions:
 *         event data only            559.1 B/instruction
 *         + transaction signatures   662.3 B/instruction   <- 6.3x baseline
 *
 * (b) is what this tool pulls. It is 1.7x CHEAPER than (a) and strictly more
 * informative: the payload is the full `BuyEvent`/`SellEvent`, which carries
 * `pool`, `user`, both quote legs, the pool reserves BEFORE the trade, and the
 * whole fee ladder including the coin-creator component. That is precisely what
 * `packages/intelligence/src/pumpswap-event.ts` already decodes off the live
 * `Program data:` log lines, so the backfill and the live tape land in the same
 * decoder and can be diffed against each other.
 *
 * Verified, not assumed: `decodePumpSwapTrade` was run against 294 events
 * pulled from this endpoint at slots 370,000,000-370,000,005 and decoded 294 of
 * them. The pool and user it produced for the first event
 * (`Fa9eiz1cV...`, `AaPNpf1UAj...`) are byte-identical to `accounts[0]` and
 * `accounts[1]` of the same trade fetched via route (a) — two independent
 * instruments agreeing, which is this project's standing bar for evidence.
 *
 * The `d8` filter is on the CPI wrapper, not on the event, so this also picks up
 * `DepositEvent` and `WithdrawEvent` — the two events MT106 needs and has never
 * had at scale — plus pool creation, for free, in the same pass.
 *
 * `--mode=trades` and `--mode=accounts` keep the other two shapes available and
 * documented rather than lost, because "we chose (b)" is only a defensible
 * claim while the alternatives are still runnable.
 *
 * ---------------------------------------------------------------------------
 * GAPS ARE RECORDED, NEVER SMOOTHED
 * ---------------------------------------------------------------------------
 *
 * Every slot range this tool covers is written to `manifest.jsonl` as a `chunk`
 * record. Every slot range it FAILED to cover — a request that exhausted its
 * retries, a range past the finalized head, an aborted run — is written as a
 * `gap` record with a reason. `coverage.json` is the rollup: merged covered
 * ranges and, explicitly, the uncovered ones inside the requested window.
 *
 * Note that a covered range legitimately contains FEWER block lines than slots.
 * Solana skips slots when a leader misses, and the portal emits a line only for
 * blocks that exist. Measured over 18,000 covered slots: 17,941 lines, 59 absent,
 * a 0.33% skip rate consistent with the chain's own. That is why coverage is
 * asserted over slot RANGES the portal answered, and never inferred by counting
 * lines — the latter would report a 0.33% gap that does not exist, every run.
 *
 * A backfill with a hole in it that reads as continuous is worse than no
 * backfill, because every rate, count and per-day figure computed off it is
 * quietly wrong and nothing in the data says so. So the invariant here is that
 * coverage is asserted from the manifest, never inferred from which files exist.
 *
 * Re-running is idempotent: the tool subtracts already-covered ranges from the
 * requested window before it asks for anything, so a second run fetches only the
 * gaps. An interrupted run resumes from a per-chunk cursor rather than
 * restarting the chunk.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *
 *   tsx scripts/sqd-backfill.ts --from=370000000 --to=370004000
 *   tsx scripts/sqd-backfill.ts --days=30 --out=data/sqd
 *   tsx scripts/sqd-backfill.ts --days=1 --dry-run
 *
 *   --from=<slot> --to=<slot>   explicit inclusive slot window
 *   --days=N                    N days back from the finalized head instead
 *   --out=<dir>                 default `data/sqd` (gitignored; checked at start)
 *   --mode=events|trades|accounts   default `events` — see above
 *   --chunk-slots=N             slots per output file, default 20000 (~2.3 hours
 *                               of chain, ~660 MB at `events` density)
 *   --gzip                      write `.jsonl.gz` (concatenated gzip members, so
 *                               resume still works). MEASURED ratio only 1.51x —
 *                               base58 payloads are close to incompressible.
 *   --rps=<float>               request rate, default 1.8 (limit is 20/10s = 2.0)
 *   --max-requests=N            stop cleanly after N requests, for probing
 *   --program=<pubkey>          default pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *   --dry-run                   plan and print, write nothing
 *
 * This tool is read-only with respect to everything else in the repo. It does
 * not open `data/runtime.db`, it does not migrate, it does not transact.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const PORTAL = 'https://portal.sqd.dev/datasets/solana-mainnet';
const STREAM = `${PORTAL}/finalized-stream`;
const FINALIZED_HEAD = `${PORTAL}/finalized-head`;

const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/**
 * `sha256("anchor:event")[0..8]` — the wrapper Anchor puts on every `emit_cpi!`
 * self-CPI. The EVENT discriminator is the next 8 bytes of the same blob, which
 * is why one `d8` here catches Buy, Sell, Deposit, Withdraw and pool creation
 * together. The portal only offers d1/d2/d4/d8, so a 16-byte filter that would
 * isolate buys and sells server-side is not available; splitting happens at
 * decode time, on data we already hold.
 */
const ANCHOR_CPI_EVENT_D8 = '0xe445a52e51cb9a1d';
/** `pump_amm` instruction discriminators, for `--mode=trades|accounts`. */
const BUY_IX_D8 = '0x66063d1201daebea';
const SELL_IX_D8 = '0x33e685a4017f83ad';

/**
 * MEASURED against block timestamps, not the 400 ms nominal. Only used to turn
 * `--days=N` into a slot count, and it is reported so the conversion is auditable.
 */
const SECONDS_PER_SLOT = 0.4164;

/** 20 requests per 10 seconds is the documented ceiling. Default under it. */
const DEFAULT_RPS = 1.8;
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

type Mode = 'events' | 'trades' | 'accounts';

interface Options {
  readonly from: number;
  readonly to: number;
  readonly out: string;
  readonly mode: Mode;
  readonly chunkSlots: number;
  readonly gzip: boolean;
  readonly rps: number;
  readonly maxRequests: number;
  readonly program: string;
  readonly dryRun: boolean;
}

interface Range {
  readonly from: number;
  readonly to: number;
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

function intFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function numFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// the portal query — one place, so what was asked for is what is documented
// ---------------------------------------------------------------------------

interface PortalQuery {
  readonly fields: Record<string, Record<string, boolean>>;
  readonly instructions: readonly Record<string, unknown>[];
}

function queryFor(mode: Mode, program: string): PortalQuery {
  if (mode === 'events') {
    return {
      fields: {
        // `number` is the slot and `timestamp` is the block time in SECONDS.
        // Both are cheap — 1,271 bytes over 1,526 instructions when measured —
        // and without them a row cannot be placed on a clock at all.
        block: { number: true, timestamp: true },
        // `transactionIndex` is the join key back to the signature. Dropping it
        // saves nothing worth having and makes the signature unattributable.
        // `instructionAddress` fixes the intra-transaction order explicitly
        // rather than trusting array position, which matters as soon as one
        // transaction touches several pools.
        instruction: { data: true, transactionIndex: true, instructionAddress: true },
        // `transaction.transactionIndex` must be REQUESTED even though the SDK
        // docs call it always-present: the portal returns only selected fields,
        // so without it every transaction object is `{"signatures":[...]}` with
        // nothing to join an instruction to. That defect ships silently — a 200,
        // full files, and 100% of instructions unattributable to a signature.
        // It was caught by validating 924,897 pulled instructions, not by review.
        transaction: { transactionIndex: true, signatures: true },
      },
      instructions: [
        {
          programId: [program],
          d8: [ANCHOR_CPI_EVENT_D8],
          isCommitted: true,
          // `transaction: true` pulls the parent transaction in so `signatures`
          // is actually populated. Requesting the field without this filter key
          // returns no transactions at all — silently, with a 200.
          transaction: true,
        },
      ],
    };
  }
  if (mode === 'trades') {
    return {
      fields: {
        block: { number: true, timestamp: true },
        instruction: { data: true, transactionIndex: true },
        transaction: { transactionIndex: true, signatures: true },
      },
      instructions: [
        { programId: [program], d8: [BUY_IX_D8, SELL_IX_D8], isCommitted: true, transaction: true },
      ],
    };
  }
  return {
    fields: {
      block: { number: true, timestamp: true },
      instruction: { data: true, accounts: true, transactionIndex: true },
      transaction: { transactionIndex: true, signatures: true },
    },
    instructions: [
      { programId: [program], d8: [BUY_IX_D8, SELL_IX_D8], isCommitted: true, transaction: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// rate limiting and retry
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Pacer {
  private last = 0;
  constructor(private readonly minGapMs: number) {}
  async wait(): Promise<void> {
    const due = this.last + this.minGapMs;
    const now = Date.now();
    if (now < due) await sleep(due - now);
    this.last = Date.now();
  }
  /** A 429 or a 409 pushes the whole schedule out, not just this request. */
  penalise(ms: number): void {
    this.last = Date.now() + ms - this.minGapMs;
  }
}

interface PortalResponse {
  /** Response body, verbatim, `''` on 204. */
  readonly body: string;
  readonly noContent: boolean;
  readonly finalizedHead: number | null;
}

class FatalPortalError extends Error {}

/**
 * One portal request with backoff. Retries 429 / 409 / 5xx / network, honouring
 * `retry-after` when present. Does NOT retry a 4xx that is our own fault — a
 * malformed query retried six times is six identical wrong answers.
 */
async function portalRequest(
  body: unknown,
  pacer: Pacer,
  onRetry: (attempt: number, why: string, waitMs: number) => void,
): Promise<PortalResponse> {
  let lastWhy = 'unknown';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await pacer.wait();
    let status = 0;
    let retryAfterMs: number | null = null;
    try {
      const res = await fetch(STREAM, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      const headRaw = res.headers.get('x-sqd-finalized-head-number');
      const finalizedHead = headRaw === null ? null : Number(headRaw);
      if (status === 200) {
        return { body: await res.text(), noContent: false, finalizedHead };
      }
      if (status === 204) {
        return { body: '', noContent: true, finalizedHead };
      }
      const text = await res.text().catch(() => '');
      lastWhy = `HTTP ${status} ${text.slice(0, 300)}`;
      if (status >= 400 && status < 500 && status !== 429 && status !== 409) {
        // 400 malformed_request, 404 unknown dataset: our defect, not theirs.
        throw new FatalPortalError(`portal refused the query: ${lastWhy}`);
      }
      const ra = res.headers.get('retry-after');
      if (ra !== null) {
        const secs = Number(ra);
        if (Number.isFinite(secs) && secs >= 0) retryAfterMs = Math.min(secs * 1_000, BACKOFF_CAP_MS);
      }
    } catch (err) {
      if (err instanceof FatalPortalError) throw err;
      lastWhy = `network ${(err as Error).message}`;
    }
    if (attempt === MAX_ATTEMPTS) break;
    const backoff = retryAfterMs ?? Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
    pacer.penalise(backoff);
    onRetry(attempt, lastWhy, backoff);
    await sleep(backoff);
  }
  throw new Error(`gave up after ${MAX_ATTEMPTS} attempts: ${lastWhy}`);
}

// ---------------------------------------------------------------------------
// manifest — the only source of truth about what is covered
// ---------------------------------------------------------------------------

interface ChunkRecord {
  readonly kind: 'chunk';
  readonly mode: Mode;
  readonly program: string;
  readonly fromSlot: number;
  readonly toSlot: number;
  readonly file: string;
  readonly blocks: number;
  readonly instructions: number;
  readonly bytesRaw: number;
  readonly bytesOnDisk: number;
  readonly requests: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

interface GapRecord {
  readonly kind: 'gap';
  readonly mode: Mode;
  readonly program: string;
  readonly fromSlot: number;
  readonly toSlot: number;
  readonly reason: string;
  readonly at: string;
}

type ManifestRecord = ChunkRecord | GapRecord;

function readManifest(path: string): ManifestRecord[] {
  if (!existsSync(path)) return [];
  const out: ManifestRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t) as ManifestRecord);
    } catch {
      // A truncated final line is what a kill -9 mid-append looks like. It is a
      // fact about the run, not a reason to refuse the other 40,000 records —
      // but it is never silently completed into a coverage claim either.
      process.stderr.write(`  ! manifest line unparseable, ignored for coverage: ${t.slice(0, 120)}\n`);
    }
  }
  return out;
}

/** Merge into disjoint, sorted, non-adjacent inclusive ranges. */
function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].filter((r) => r.to >= r.from).sort((a, b) => a.from - b.from);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.from <= last.to + 1) {
      if (r.to > last.to) out[out.length - 1] = { from: last.from, to: r.to };
    } else {
      out.push({ from: r.from, to: r.to });
    }
  }
  return out;
}

/** `want` minus `have`, as inclusive ranges. */
function subtractRanges(want: Range, have: readonly Range[]): Range[] {
  const out: Range[] = [];
  let cursor = want.from;
  for (const h of mergeRanges(have)) {
    if (h.to < cursor) continue;
    if (h.from > want.to) break;
    if (h.from > cursor) out.push({ from: cursor, to: Math.min(h.from - 1, want.to) });
    cursor = Math.max(cursor, h.to + 1);
    if (cursor > want.to) break;
  }
  if (cursor <= want.to) out.push({ from: cursor, to: want.to });
  return out;
}

/** Split a range on a global grid, so chunk files from different runs align. */
function splitOnGrid(range: Range, grid: number): Range[] {
  const out: Range[] = [];
  let from = range.from;
  while (from <= range.to) {
    const cellEnd = Math.floor(from / grid) * grid + grid - 1;
    const to = Math.min(cellEnd, range.to);
    out.push({ from, to });
    from = to + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function humanBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// ---------------------------------------------------------------------------
// chunk fetch, with a cursor so an interrupted run resumes
// ---------------------------------------------------------------------------

interface Cursor {
  readonly nextSlot: number;
  readonly bytesOnDisk: number;
  readonly blocks: number;
  readonly instructions: number;
  readonly bytesRaw: number;
  readonly requests: number;
  readonly startedAt: string;
}

interface ChunkOutcome {
  readonly coveredTo: number;
  readonly blocks: number;
  readonly instructions: number;
  readonly bytesRaw: number;
  readonly bytesOnDisk: number;
  readonly requests: number;
  readonly file: string | null;
  readonly startedAt: string;
  /** Non-null when the chunk did NOT reach `range.to`. */
  readonly gapReason: string | null;
}

/** Portal blocks arrive as `{"header":{"number":...},...}`, one per line. */
function scanBody(body: string): { lines: number; lastSlot: number | null; instructions: number } {
  let lines = 0;
  let lastSlot: number | null = null;
  let instructions = 0;
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    lines++;
    let parsed: { header?: { number?: unknown }; instructions?: unknown[] };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch (err) {
      // Fail closed. A body we cannot fully parse cannot be used to advance a
      // cursor, because the cursor is a coverage claim.
      throw new Error(`portal returned a line that is not JSON: ${(err as Error).message}`);
    }
    const n = parsed.header?.number;
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      throw new Error('portal returned a block with no integer header.number');
    }
    lastSlot = n;
    instructions += Array.isArray(parsed.instructions) ? parsed.instructions.length : 0;
  }
  return { lines, lastSlot, instructions };
}

async function fetchChunk(
  range: Range,
  opts: Options,
  query: PortalQuery,
  pacer: Pacer,
  dir: string,
  budget: { remaining: number },
  progress: (nextSlot: number, instructions: number, bytesRaw: number) => void,
): Promise<ChunkOutcome> {
  const ext = opts.gzip ? 'jsonl.gz' : 'jsonl';
  const base = `${opts.mode}-${range.from}-${range.to}`;
  const finalPath = join(dir, `${base}.${ext}`);
  const partPath = join(dir, `${base}.${ext}.part`);
  const cursorPath = join(dir, `${base}.cursor.json`);

  let cursor: Cursor = {
    nextSlot: range.from,
    bytesOnDisk: 0,
    blocks: 0,
    instructions: 0,
    bytesRaw: 0,
    requests: 0,
    startedAt: new Date().toISOString(),
  };

  if (existsSync(cursorPath) && existsSync(partPath)) {
    try {
      const saved = JSON.parse(readFileSync(cursorPath, 'utf8')) as Cursor;
      if (saved.nextSlot >= range.from && saved.nextSlot <= range.to + 1) {
        cursor = saved;
        process.stdout.write(
          `  resume ${base} at slot ${cursor.nextSlot} (${humanBytes(cursor.bytesOnDisk)} already on disk)\n`,
        );
      }
    } catch {
      process.stderr.write(`  ! cursor for ${base} unreadable; restarting the chunk\n`);
    }
  }

  // The part file may be LONGER than the cursor says if we died between the data
  // fsync and the cursor write. Truncating to the cursor is the only safe move:
  // bytes past it were never counted as covered.
  const fd = openSync(partPath, existsSync(partPath) ? 'r+' : 'w+');
  try {
    const onDisk = fstatSync(fd).size;
    if (onDisk > cursor.bytesOnDisk) ftruncateSync(fd, cursor.bytesOnDisk);

    let gapReason: string | null = null;
    while (cursor.nextSlot <= range.to) {
      if (budget.remaining <= 0) {
        gapReason = `--max-requests budget exhausted at slot ${cursor.nextSlot}`;
        break;
      }
      const body = {
        type: 'solana',
        fromBlock: cursor.nextSlot,
        toBlock: range.to,
        fields: query.fields,
        instructions: query.instructions,
      };
      budget.remaining--;
      let res: PortalResponse;
      try {
        res = await portalRequest(body, pacer, (attempt, why, waitMs) => {
          process.stderr.write(
            `  ~ retry ${attempt}/${MAX_ATTEMPTS} at slot ${cursor.nextSlot} in ${waitMs}ms: ${why}\n`,
          );
        });
      } catch (err) {
        if (err instanceof FatalPortalError) throw err;
        gapReason = `request failed at slot ${cursor.nextSlot}: ${(err as Error).message}`;
        break;
      }

      if (res.noContent) {
        // 204 means `fromBlock` is past what the portal has finalized. That is a
        // real gap in what we asked for, and it is written down as one.
        gapReason = `204 no content from slot ${cursor.nextSlot} (past finalized head ${res.finalizedHead ?? '?'})`;
        break;
      }

      const scan = scanBody(res.body);
      if (scan.lastSlot === null) {
        // The portal emits the first and last block of a satisfied range even
        // when neither matched. Zero lines therefore is not "no data here", it
        // is an answer we do not understand — so we refuse rather than assume.
        gapReason = `portal returned 200 with zero blocks at slot ${cursor.nextSlot}`;
        break;
      }
      if (scan.lastSlot < cursor.nextSlot) {
        gapReason = `portal went backwards: asked from ${cursor.nextSlot}, last block ${scan.lastSlot}`;
        break;
      }

      const payload = res.body.endsWith('\n') ? res.body : `${res.body}\n`;
      const bytes = opts.gzip ? gzipSync(Buffer.from(payload, 'utf8'), { level: 6 }) : Buffer.from(payload, 'utf8');
      // Concatenated gzip members decompress as one stream, so appending a fresh
      // member per response keeps `--gzip` resumable at member granularity.
      writeSync(fd, bytes, 0, bytes.length, cursor.bytesOnDisk);
      fsyncSync(fd);

      cursor = {
        nextSlot: scan.lastSlot + 1,
        bytesOnDisk: cursor.bytesOnDisk + bytes.length,
        blocks: cursor.blocks + scan.lines,
        instructions: cursor.instructions + scan.instructions,
        bytesRaw: cursor.bytesRaw + payload.length,
        requests: cursor.requests + 1,
        startedAt: cursor.startedAt,
      };
      // Cursor after data, atomically. A crash between the two truncates back.
      writeFileSync(`${cursorPath}.tmp`, JSON.stringify(cursor), 'utf8');
      renameSync(`${cursorPath}.tmp`, cursorPath);
      progress(cursor.nextSlot, scan.instructions, payload.length);
    }

    closeSync(fd);
    const coveredTo = Math.min(cursor.nextSlot - 1, range.to);
    if (coveredTo < range.from) {
      // Nothing at all landed. Leave no empty file behind.
      rmSync(partPath, { force: true });
      rmSync(cursorPath, { force: true });
      return {
        coveredTo: range.from - 1,
        blocks: 0,
        instructions: 0,
        bytesRaw: 0,
        bytesOnDisk: 0,
        requests: cursor.requests,
        file: null,
        startedAt: cursor.startedAt,
        gapReason: gapReason ?? 'no blocks returned',
      };
    }
    // Name the file by what it ACTUALLY covers, so a partially-filled chunk is
    // not mistakable for a complete one by filename alone.
    const actual = join(dir, `${opts.mode}-${range.from}-${coveredTo}.${ext}`);
    renameSync(partPath, gapReason === null ? finalPath : actual);
    rmSync(cursorPath, { force: true });
    return {
      coveredTo,
      blocks: cursor.blocks,
      instructions: cursor.instructions,
      bytesRaw: cursor.bytesRaw,
      bytesOnDisk: cursor.bytesOnDisk,
      requests: cursor.requests,
      file: gapReason === null ? finalPath : actual,
      startedAt: cursor.startedAt,
      gapReason,
    };
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function finalizedHead(): Promise<number> {
  const res = await fetch(FINALIZED_HEAD, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`finalized-head returned HTTP ${res.status}`);
  const j = (await res.json()) as { number?: unknown };
  if (typeof j.number !== 'number') throw new Error('finalized-head returned no numeric `number`');
  return j.number;
}

function assertGitignored(outDir: string): void {
  const r = spawnSync('git', ['check-ignore', '-q', join(outDir, 'probe')], { encoding: 'utf8' });
  if (r.status === 0) return;
  process.stderr.write(
    `\n  !! ${outDir} is NOT gitignored. This tool writes tens of gigabytes.\n` +
      `     Add it to .gitignore before running anything but --dry-run.\n\n`,
  );
}

async function main(): Promise<void> {
  if (flag('help') !== null) {
    process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0] ?? '');
    return;
  }

  const modeRaw = flag('mode') ?? 'events';
  if (modeRaw !== 'events' && modeRaw !== 'trades' && modeRaw !== 'accounts') {
    throw new Error(`--mode must be events|trades|accounts, got ${JSON.stringify(modeRaw)}`);
  }
  const dryRun = flag('dry-run') !== null;
  const head = await finalizedHead();

  const days = numFlag('days', 0);
  let from = intFlag('from', 0);
  let to = intFlag('to', 0);
  if (days > 0) {
    if (from !== 0 || to !== 0) throw new Error('--days cannot be combined with --from/--to');
    to = head;
    from = head - Math.round((days * 86_400) / SECONDS_PER_SLOT);
  }
  if (from === 0 || to === 0) {
    throw new Error('need --from=<slot> --to=<slot>, or --days=N. Pass --help for the full note.');
  }
  if (to < from) throw new Error(`--to (${to}) is below --from (${from})`);

  const clamped = Math.min(to, head);
  const clampedAway = to > head ? { from: head + 1, to } : null;

  const opts: Options = {
    from,
    to: clamped,
    out: resolve(flag('out') ?? 'data/sqd'),
    mode: modeRaw,
    chunkSlots: intFlag('chunk-slots', 20_000),
    gzip: flag('gzip') !== null,
    rps: numFlag('rps', DEFAULT_RPS),
    maxRequests: intFlag('max-requests', Number.MAX_SAFE_INTEGER),
    program: flag('program') ?? PUMP_AMM,
    dryRun,
  };
  if (opts.chunkSlots < 1) throw new Error('--chunk-slots must be >= 1');
  if (opts.rps > 2) {
    throw new Error(`--rps=${opts.rps} exceeds the documented 20 requests / 10 s ceiling`);
  }

  const dir = join(opts.out, `${opts.mode}-${opts.program.slice(0, 8)}`);
  const manifestPath = join(dir, 'manifest.jsonl');
  const coveragePath = join(dir, 'coverage.json');

  const wantedSlots = opts.to - opts.from + 1;
  process.stdout.write(
    [
      `sqd-backfill  mode=${opts.mode} program=${opts.program}`,
      `  window        ${opts.from} .. ${opts.to}  (${wantedSlots.toLocaleString()} slots`,
      `                 ~${(wantedSlots * SECONDS_PER_SLOT / 86_400).toFixed(2)} days at ${SECONDS_PER_SLOT}s/slot)`,
      `  finalized head ${head}`,
      `  out           ${dir}${opts.gzip ? '  (gzip)' : ''}`,
      `  chunk         ${opts.chunkSlots.toLocaleString()} slots     rate ${opts.rps} req/s`,
      '',
    ].join('\n'),
  );
  if (clampedAway !== null) {
    process.stdout.write(
      `  ! --to clamped to the finalized head; ${clampedAway.from}..${clampedAway.to} is not yet available\n\n`,
    );
  }

  assertGitignored(opts.out);
  if (!dryRun) mkdirSync(dir, { recursive: true });

  const priorRecords = dryRun && !existsSync(manifestPath) ? [] : readManifest(manifestPath);
  const covered = mergeRanges(
    priorRecords
      .filter((r): r is ChunkRecord => r.kind === 'chunk' && r.mode === opts.mode && r.program === opts.program)
      .map((r) => ({ from: r.fromSlot, to: r.toSlot })),
  );
  const todo = subtractRanges({ from: opts.from, to: opts.to }, covered)
    .flatMap((r) => splitOnGrid(r, opts.chunkSlots));
  const todoSlots = todo.reduce((a, r) => a + (r.to - r.from + 1), 0);
  const alreadySlots = wantedSlots - todoSlots;

  process.stdout.write(
    `  already covered ${alreadySlots.toLocaleString()} slots in ${covered.length} range(s); ` +
      `${todoSlots.toLocaleString()} slots to pull in ${todo.length} chunk(s)\n\n`,
  );

  if (dryRun) {
    for (const r of todo.slice(0, 10)) process.stdout.write(`  would fetch ${r.from} .. ${r.to}\n`);
    if (todo.length > 10) process.stdout.write(`  ... and ${todo.length - 10} more\n`);
    process.stdout.write('\ndry run: nothing written.\n');
    return;
  }

  const query = queryFor(opts.mode, opts.program);
  const pacer = new Pacer(1_000 / opts.rps);
  const budget = { remaining: opts.maxRequests };
  const appendManifest = (rec: ManifestRecord): void => {
    appendFileSync(manifestPath, `${JSON.stringify(rec)}\n`, 'utf8');
  };
  if (clampedAway !== null) {
    appendManifest({
      kind: 'gap',
      mode: opts.mode,
      program: opts.program,
      fromSlot: clampedAway.from,
      toSlot: clampedAway.to,
      reason: `requested --to=${to} is above the finalized head ${head}`,
      at: new Date().toISOString(),
    });
  }

  const t0 = Date.now();
  let doneSlots = 0;
  /** Slots this process actually fetched, which is what the rate is measured on. */
  let pulledSlots = 0;
  let totalInstr = 0;
  let totalRaw = 0;
  let totalDisk = 0;
  let totalRequests = 0;
  let gaps = 0;
  let lastPrint = 0;

  for (const range of todo) {
    const chunkSlots = range.to - range.from + 1;
    const out = await fetchChunk(range, opts, query, pacer, dir, budget, (nextSlot, instr, raw) => {
      totalInstr += instr;
      totalRaw += raw;
      totalRequests++;
      const slotsNow = doneSlots + Math.max(0, Math.min(nextSlot - 1, range.to) - range.from + 1);
      const now = Date.now();
      if (now - lastPrint < 1_500) return;
      lastPrint = now;
      const elapsed = now - t0;
      const rate = slotsNow / (elapsed / 1000);
      const remaining = todoSlots - slotsNow;
      process.stdout.write(
        `  ${((slotsNow / todoSlots) * 100).toFixed(1).padStart(5)}%  ` +
          `slot ${nextSlot}  ${slotsNow.toLocaleString()}/${todoSlots.toLocaleString()} slots  ` +
          `${totalInstr.toLocaleString()} instr  ${humanBytes(totalRaw)}  ` +
          `${rate.toFixed(0)} slot/s  elapsed ${humanDuration(elapsed)}  ` +
          `eta ${humanDuration(rate > 0 ? (remaining / rate) * 1000 : NaN)}\n`,
      );
    });

    totalDisk += out.bytesOnDisk;
    const finishedAt = new Date().toISOString();
    if (out.coveredTo >= range.from && out.file !== null) {
      appendManifest({
        kind: 'chunk',
        mode: opts.mode,
        program: opts.program,
        fromSlot: range.from,
        toSlot: out.coveredTo,
        file: out.file.slice(dir.length + 1),
        blocks: out.blocks,
        instructions: out.instructions,
        bytesRaw: out.bytesRaw,
        bytesOnDisk: out.bytesOnDisk,
        requests: out.requests,
        startedAt: out.startedAt,
        finishedAt,
      });
    }
    if (out.gapReason !== null) {
      gaps++;
      const gapFrom = Math.max(range.from, out.coveredTo + 1);
      appendManifest({
        kind: 'gap',
        mode: opts.mode,
        program: opts.program,
        fromSlot: gapFrom,
        toSlot: range.to,
        reason: out.gapReason,
        at: finishedAt,
      });
      process.stderr.write(`  ! GAP ${gapFrom}..${range.to}: ${out.gapReason}\n`);
    }
    doneSlots += chunkSlots;
    if (out.coveredTo >= range.from) pulledSlots += out.coveredTo - range.from + 1;
    if (budget.remaining <= 0) {
      process.stdout.write(`\n  stopped: --max-requests budget spent.\n`);
      break;
    }
  }

  // Coverage rollup, recomputed from the manifest rather than from this run, so
  // it is right after an interrupted run too.
  const all = readManifest(manifestPath).filter(
    (r) => r.mode === opts.mode && r.program === opts.program,
  );
  const coveredNow = mergeRanges(
    all.filter((r): r is ChunkRecord => r.kind === 'chunk').map((r) => ({ from: r.fromSlot, to: r.toSlot })),
  );
  const window: Range = {
    from: Math.min(opts.from, ...coveredNow.map((r) => r.from), opts.from),
    to: Math.max(opts.to, ...coveredNow.map((r) => r.to), opts.to),
  };
  const uncovered = subtractRanges(window, coveredNow);
  const chunkRecs = all.filter((r): r is ChunkRecord => r.kind === 'chunk');
  writeFileSync(
    coveragePath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        endpoint: STREAM,
        program: opts.program,
        mode: opts.mode,
        query: queryFor(opts.mode, opts.program),
        secondsPerSlot: SECONDS_PER_SLOT,
        window,
        coveredRanges: coveredNow,
        coveredSlots: coveredNow.reduce((a, r) => a + (r.to - r.from + 1), 0),
        uncoveredRanges: uncovered,
        uncoveredSlots: uncovered.reduce((a, r) => a + (r.to - r.from + 1), 0),
        gapRecords: all.filter((r): r is GapRecord => r.kind === 'gap'),
        files: chunkRecs.length,
        instructions: chunkRecs.reduce((a, r) => a + r.instructions, 0),
        blocks: chunkRecs.reduce((a, r) => a + r.blocks, 0),
        bytesRaw: chunkRecs.reduce((a, r) => a + r.bytesRaw, 0),
        bytesOnDisk: chunkRecs.reduce((a, r) => a + r.bytesOnDisk, 0),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const elapsed = Date.now() - t0;
  // Measured on what THIS process pulled. Deriving it from the coverage rollup
  // instead would silently credit this run with slots a previous run fetched.
  const slotsPulled = pulledSlots;
  const rate = slotsPulled > 0 && elapsed > 0 ? slotsPulled / (elapsed / 1000) : 0;
  process.stdout.write(
    [
      '',
      `done in ${humanDuration(elapsed)}`,
      `  requests      ${totalRequests.toLocaleString()}`,
      `  slots pulled  ${Math.max(0, slotsPulled).toLocaleString()}   (${rate.toFixed(0)} slot/s)`,
      `  instructions  ${totalInstr.toLocaleString()}`,
      `  bytes         ${humanBytes(totalRaw)} raw, ${humanBytes(totalDisk)} on disk`,
      `  per instr     ${totalInstr > 0 ? (totalRaw / totalInstr).toFixed(1) : '-'} B`,
      `  per slot      ${slotsPulled > 0 ? (totalRaw / slotsPulled).toFixed(0) : '-'} B, ` +
        `${slotsPulled > 0 ? (totalInstr / slotsPulled).toFixed(1) : '-'} instr`,
      `  GAPS          ${gaps} this run; ${uncovered.length} uncovered range(s) in the window ` +
        `(${uncovered.reduce((a, r) => a + (r.to - r.from + 1), 0).toLocaleString()} slots)`,
      `  manifest      ${manifestPath}`,
      `  coverage      ${coveragePath}`,
      '',
    ].join('\n'),
  );
  if (uncovered.length > 0) {
    for (const r of uncovered.slice(0, 20)) process.stdout.write(`    uncovered ${r.from} .. ${r.to}\n`);
    if (uncovered.length > 20) process.stdout.write(`    ... and ${uncovered.length - 20} more\n`);
    process.stdout.write('\n  Re-run the same command to fill these; it fetches only what is missing.\n');
  }

  // A projection is only honest with the rate it was measured at, so it is
  // printed from this run's numbers rather than from a constant.
  if (rate > 0 && totalRaw > 0) {
    const slots30d = Math.round((30 * 86_400) / SECONDS_PER_SLOT);
    const bytesPerSlot = totalRaw / slotsPulled;
    process.stdout.write(
      `  at this run's rate, 30 days (${slots30d.toLocaleString()} slots) is ` +
        `${humanDuration((slots30d / rate) * 1000)} and ${humanBytes(slots30d * bytesPerSlot)} raw.\n`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\nsqd-backfill failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});

/** Exported for tests: range algebra is where a silent coverage lie would hide. */
export const __internals = { mergeRanges, subtractRanges, splitOnGrid, scanBody };
