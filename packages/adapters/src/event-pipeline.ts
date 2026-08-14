import { pumpInstructionFromLogs, TRADE_INSTRUCTIONS, MIGRATION_INSTRUCTIONS } from './logswatch.js';
import type { ProgramLogEvent } from './logswatch.js';

/**
 * P8 — a bounded, program-stack-aware pipeline instead of a firehose.
 *
 * Measured on the previous build: 1,055 events/second, 6,981,407 rows in 111
 * minutes, a projected 91 million rows per day, and the database grew from
 * 2.97 GB to 6.15 GB in one session. Sixty-eight per cent of those rows were
 * `UNKNOWN` — a log block whose instruction the parser could not name — written
 * synchronously to the authoritative research database.
 *
 * The decision-useful yield was 43 migration events out of seven million rows.
 *
 * That is not a capacity problem. Persisting every raw notification is the
 * defect, and a bigger disk makes it worse rather than better: the corpus is
 * the research asset and it is not reproducible.
 *
 * This pipeline is:
 *
 *   socket receive -> bounded queue -> stack-aware parse -> dedup ->
 *   decision-useful event OR a counter
 *
 * A dropped event increments a counter. A counter is a fact about coverage;
 * an unbounded queue is a fact about memory.
 */

export type EventKind = 'TRADE' | 'MIGRATION' | 'LAUNCH' | 'CONFIG' | 'UNKNOWN';

export interface ParsedEvent {
  readonly signature: string;
  readonly slot: number;
  readonly programId: string;
  readonly kind: EventKind;
  readonly instruction: string | null;
  /** The mint this event is ABOUT. Null when the logs do not name one. */
  readonly mint: string | null;
  readonly pool: string | null;
  readonly commitment: string;
  readonly receivedMonotonicMs: number;
  readonly receivedUtcMs: number;
  readonly err: string | null;
}

export interface PipelineCounters {
  received: number;
  parsed: number;
  unknown: number;
  duplicates: number;
  dropped: number;
  persisted: number;
  unknownSampled: number;
  queueHighWater: number;
  bytesIn: number;
}

/**
 * The program invocation stack, from the runtime's own log lines.
 *
 * `Program X invoke [1]` / `Program X success` bracket an invocation, and the
 * depth is in the brackets. Taking the FIRST `Program log: Instruction:` line
 * attributes a CPI's inner instruction to the outer program — so a Jupiter
 * route through Pump reads as a Pump instruction, and a Pump instruction that
 * CPIs into the token program reads as whichever came first in the text.
 *
 * Returns the instruction executed by `programId` at the depth it was invoked.
 */
export function instructionForProgram(logs: readonly string[], programId: string): string | null {
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke !== null && invoke[1] !== undefined) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \S+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    const ix = /^Program log: Instruction: (\w+)$/.exec(line);
    if (ix !== null && ix[1] !== undefined && stack[stack.length - 1] === programId) {
      return ix[1];
    }
  }
  return null;
}

/** Base58 addresses the logs name, in order of appearance. */
function addressesIn(logs: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of logs) {
    for (const m of line.matchAll(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g)) {
      if (m[1] !== undefined) out.push(m[1]);
    }
  }
  return out;
}

const SYSTEM_ADDRESSES = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
]);

/**
 * Parse one raw notification into something a decision could use.
 *
 * Returns null when the event carries no identity — and null means DROPPED,
 * counted, not persisted. An event that cannot name a mint or a pool cannot
 * inform a candidate queue, a migration age or a reserve alarm, which are the
 * only three things this stream exists to feed.
 */
export function parseEvent(e: ProgramLogEvent): ParsedEvent | null {
  // Stack-aware first; the flat scan is a fallback that says so by being second.
  const ix = instructionForProgram(e.logs, e.programId) ?? pumpInstructionFromLogs(e.logs);

  const kind: EventKind =
    ix === null
      ? 'UNKNOWN'
      : MIGRATION_INSTRUCTIONS.has(ix)
        ? 'MIGRATION'
        : TRADE_INSTRUCTIONS.has(ix)
          ? 'TRADE'
          : /create|initialize/i.test(ix)
            ? 'LAUNCH'
            : /config|fee|authority|pause/i.test(ix)
              ? 'CONFIG'
              : 'UNKNOWN';

  if (kind === 'UNKNOWN') return null;

  const addrs = addressesIn(e.logs).filter((a) => !SYSTEM_ADDRESSES.has(a) && a !== e.programId);
  return {
    signature: e.signature,
    slot: e.slot,
    programId: e.programId,
    kind,
    instruction: ix,
    // Best-effort identity from the logs. Null rather than a guess: a wrong
    // mint is worse than no mint, because it attributes flow to a token that
    // had none.
    mint: addrs[0] ?? null,
    pool: addrs[1] ?? null,
    commitment: e.commitment,
    receivedMonotonicMs: e.receivedMonotonicMs,
    receivedUtcMs: e.receivedUtcMs,
    err: e.err,
  };
}

export interface PipelineOptions {
  /** Hard ceiling on queued events. Beyond it, events are DROPPED and counted. */
  readonly maxQueue?: number;
  /** Persist at most one UNKNOWN in this many, so the parser stays auditable. */
  readonly unknownSampleRate?: number;
  readonly onEvent: (e: ParsedEvent) => void;
  /** A bounded sample of unparsed events, for improving the parser. */
  readonly onUnknownSample: (e: ProgramLogEvent) => void;
}

/**
 * The bounded queue.
 *
 * Backpressure is a DROP with a counter, never an unbounded array. The
 * previous build had no queue at all: every notification went straight to a
 * synchronous INSERT, so the socket's rate was the database's write rate.
 */
export class EventPipeline {
  readonly counters: PipelineCounters = {
    received: 0,
    parsed: 0,
    unknown: 0,
    duplicates: 0,
    dropped: 0,
    persisted: 0,
    unknownSampled: 0,
    queueHighWater: 0,
    bytesIn: 0,
  };

  private readonly queue: ProgramLogEvent[] = [];
  private readonly seen = new Set<string>();
  private unknownSeen = 0;
  private draining = false;
  private scheduled = false;

  constructor(private readonly opts: PipelineOptions) {}

  /** Non-blocking. Returns false when the event was dropped. */
  offer(e: ProgramLogEvent): boolean {
    this.counters.received += 1;
    this.counters.bytesIn += e.logs.reduce((n, l) => n + l.length, 0);

    const max = this.opts.maxQueue ?? 10_000;
    if (this.queue.length >= max) {
      this.counters.dropped += 1;
      return false;
    }
    this.queue.push(e);
    if (this.queue.length > this.counters.queueHighWater) {
      this.counters.queueHighWater = this.queue.length;
    }
    this.schedule();
    return true;
  }

  /**
   * Drain on a LATER turn, never inside `offer`.
   *
   * Draining synchronously made the bound meaningless: each event was parsed
   * and inserted before `offer` returned, so the queue never held more than
   * one and `maxQueue` could never be reached. That is the previous design
   * with extra steps — the socket's arrival rate is still the database's write
   * rate, and a burst still blocks the event loop inside a synchronous INSERT.
   *
   * Deferring is what makes the queue absorb a burst, and what makes a drop a
   * real decision rather than an unreachable branch.
   */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.drain();
      // More arrived while we worked: come back on another turn rather than
      // looping here and starving the mark scheduler.
      if (this.queue.length > 0) this.schedule();
    });
  }

  /** Drain now. For tests and for a final flush at shutdown. */
  drainNow(): void {
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      // Bounded per turn, so a burst cannot monopolise the event loop and
      // starve the mark scheduler.
      let budget = 256;
      while (budget-- > 0) {
        const e = this.queue.shift();
        if (e === undefined) break;

        // The same signature reaches us once per program it mentions.
        const key = `${e.signature}:${e.programId}`;
        if (this.seen.has(key)) {
          this.counters.duplicates += 1;
          continue;
        }
        this.seen.add(key);
        // Bounded memory: the set is a recency filter, not a ledger.
        if (this.seen.size > 50_000) this.seen.clear();

        const parsed = parseEvent(e);
        if (parsed === null) {
          this.counters.unknown += 1;
          this.unknownSeen += 1;
          const rate = this.opts.unknownSampleRate ?? 1_000;
          if (this.unknownSeen % rate === 0) {
            this.counters.unknownSampled += 1;
            this.opts.onUnknownSample(e);
          }
          continue;
        }
        this.counters.parsed += 1;
        this.counters.persisted += 1;
        this.opts.onEvent(parsed);
      }
    } finally {
      this.draining = false;
    }
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  /** Parsed fraction, for the throughput artifact. Null before any event. */
  get parsedFraction(): number | null {
    const decided = this.counters.parsed + this.counters.unknown;
    return decided === 0 ? null : this.counters.parsed / decided;
  }
}
