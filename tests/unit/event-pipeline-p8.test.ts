import { describe, it, expect } from 'vitest';
import {
  EventPipeline,
  instructionForProgram,
  parseEvent,
  type ParsedEvent,
} from '../../packages/adapters/src/event-pipeline.js';
import type { ProgramLogEvent } from '../../packages/adapters/src/logswatch.js';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const ev = (over: Partial<ProgramLogEvent> = {}): ProgramLogEvent => ({
  signature: 'sig1',
  slot: 100,
  programId: PUMP,
  logs: [],
  commitment: 'processed',
  receivedMonotonicMs: 1,
  receivedUtcMs: 1_000,
  err: null,
  ...over,
});

describe('P8 — the parser knows which program ran which instruction', () => {
  it('attributes a CPI inner instruction to the INNER program, not the outer', () => {
    // THE defect. Taking the first `Program log: Instruction:` line reads a
    // Jupiter route through Pump as whichever instruction appeared first in
    // the text, so flow gets attributed to the wrong program.
    const logs = [
      `Program ${JUP} invoke [1]`,
      'Program log: Instruction: Route',
      `Program ${PUMP} invoke [2]`,
      'Program log: Instruction: Buy',
      `Program ${TOKEN} invoke [3]`,
      'Program log: Instruction: Transfer',
      `Program ${TOKEN} success`,
      `Program ${PUMP} success`,
      `Program ${JUP} success`,
    ];
    expect(instructionForProgram(logs, PUMP)).toBe('Buy');
    expect(instructionForProgram(logs, JUP)).toBe('Route');
    expect(instructionForProgram(logs, TOKEN)).toBe('Transfer');
  });

  it('returns null when the named program did not run', () => {
    const logs = [`Program ${JUP} invoke [1]`, 'Program log: Instruction: Route', `Program ${JUP} success`];
    expect(instructionForProgram(logs, PUMP)).toBeNull();
  });

  it('pops the stack on failure as well as success', () => {
    const logs = [
      `Program ${JUP} invoke [1]`,
      `Program ${PUMP} invoke [2]`,
      `Program ${PUMP} failed: custom error`,
      'Program log: Instruction: Route',
      `Program ${JUP} success`,
    ];
    // The `Route` line belongs to Jupiter: Pump's frame already closed.
    expect(instructionForProgram(logs, JUP)).toBe('Route');
    expect(instructionForProgram(logs, PUMP)).toBeNull();
  });
});

describe('P8 — an event without identity is dropped, not stored', () => {
  it('drops an unnameable log block', () => {
    // 4,749,409 of these were persisted. A row that cannot name a mint or a
    // pool informs no candidate queue, no migration age and no reserve alarm.
    expect(parseEvent(ev({ logs: ['Program log: ray_log: AaBb'] }))).toBeNull();
  });

  it('keeps a trade and carries its identity', () => {
    const mint = '6e5KR79A5LfNT6EGbFkbaqMeAu7RPYd7AoQiVHLriMhJ';
    const pool = '7QpN1eoMHvq9VWyf5e9g44d5u5bW1hYnemaR7eZfU5RK';
    const p = parseEvent(
      ev({
        logs: [
          `Program ${PUMP} invoke [1]`,
          'Program log: Instruction: Buy',
          `Program log: pool ${pool} mint ${mint}`,
          `Program ${PUMP} success`,
        ],
      }),
    );
    expect(p).not.toBeNull();
    expect((p as ParsedEvent).kind).toBe('TRADE');
    expect((p as ParsedEvent).instruction).toBe('Buy');
    expect((p as ParsedEvent).mint).toBe(pool);
  });

  it('keeps a migration, which is the rarest and most decision-useful event', () => {
    const p = parseEvent(
      ev({ logs: [`Program ${PUMP} invoke [1]`, 'Program log: Instruction: Migrate', `Program ${PUMP} success`] }),
    );
    expect((p as ParsedEvent).kind).toBe('MIGRATION');
  });

  it('keeps a failed transaction as an event, not as a trade outcome', () => {
    const p = parseEvent(
      ev({
        logs: [`Program ${PUMP} invoke [1]`, 'Program log: Instruction: Sell', `Program ${PUMP} success`],
        err: '{"InstructionError":[0,"X"]}',
      }),
    );
    expect((p as ParsedEvent).err).not.toBeNull();
  });
});

describe('P8 — the queue is bounded', () => {
  const sink = () => {
    const out: ParsedEvent[] = [];
    const unknown: ProgramLogEvent[] = [];
    const p = new EventPipeline({
      maxQueue: 4,
      unknownSampleRate: 2,
      onEvent: (e) => out.push(e),
      onUnknownSample: (e) => unknown.push(e),
    });
    return { p, out, unknown };
  };

  it('drops beyond the ceiling and counts it, rather than growing', () => {
    // The previous build had no queue: the socket's rate WAS the database's
    // write rate, and 1,055 events/second went straight into synchronous
    // INSERTs.
    const stuck = new EventPipeline({ maxQueue: 2, onEvent: () => {}, onUnknownSample: () => {} });
    // Nothing drains between offers, because the drain is scheduled for a
    // later turn. That is the whole point: the queue absorbs the burst and
    // then refuses, rather than the socket's rate being the write rate.
    for (let i = 0; i < 10; i++) stuck.offer(ev({ signature: `s${i}`, logs: ['noise'] }));
    expect(stuck.counters.received).toBe(10);
    expect(stuck.counters.dropped).toBe(8);
    expect(stuck.queueDepth).toBe(2);
  });

  it('deduplicates the same signature reaching us twice', () => {
    const { p, out } = sink();
    const logs = [`Program ${PUMP} invoke [1]`, 'Program log: Instruction: Buy', `Program ${PUMP} success`];
    p.offer(ev({ signature: 'dupe', logs }));
    p.offer(ev({ signature: 'dupe', logs }));
    p.drainNow();
    expect(out).toHaveLength(1);
    expect(p.counters.duplicates).toBe(1);
  });

  it('samples unknowns at a bounded rate instead of storing all of them', () => {
    // A queue big enough to absorb all ten, so this measures the SAMPLE RATE
    // rather than the drop ceiling — those are different properties and the
    // previous expectation conflated them.
    const unknown: ProgramLogEvent[] = [];
    const p = new EventPipeline({
      maxQueue: 100,
      unknownSampleRate: 2,
      onEvent: () => {},
      onUnknownSample: (e) => unknown.push(e),
    });
    for (let i = 0; i < 10; i++) p.offer(ev({ signature: `u${i}`, logs: ['noise'] }));
    p.drainNow();
    expect(p.counters.unknown).toBe(10);
    // One in two, not ten in ten.
    expect(unknown.length).toBe(5);
  });

  it('reports the parsed fraction, so the parser stays auditable', () => {
    const { p } = sink();
    expect(p.parsedFraction).toBeNull();
    const logs = [`Program ${PUMP} invoke [1]`, 'Program log: Instruction: Buy', `Program ${PUMP} success`];
    p.offer(ev({ signature: 'a', logs }));
    p.offer(ev({ signature: 'b', logs: ['noise'] }));
    p.drainNow();
    expect(p.parsedFraction).toBe(0.5);
  });
});
