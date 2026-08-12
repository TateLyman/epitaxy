import fc from 'fast-check';
import { suppressDotEnvForTests } from '../packages/domain/src/dotenv.js';

/**
 * No test reads the operator's `.env`.
 *
 * `loadSecrets()` calls `loadDotEnvOnce()`, so the moment O031 was closed every
 * secrets test began inheriting whatever was on the developer's disk.
 * `tests/unit/secrets.test.ts` asserts that an unset key yields a null RPC
 * endpoint; on a configured machine it saw the real Helius URL instead. A suite
 * must describe the code, not the checkout it happens to run in — and a test
 * that only passes before the system is configured is worse than no test.
 *
 * Suppressed here rather than by deleting variables afterwards, so the secret
 * never enters `process.env` at all during a test run.
 *
 * `tests/unit/dotenv.test.ts` calls `resetDotEnvForTests()` in its own
 * `afterEach` and points the loader at temporary directories, so the real load
 * path is still exercised.
 */
suppressDotEnvForTests();

/**
 * Global bounds for property tests.
 *
 * `testTimeout` cannot rescue a property test. fast-check searches and shrinks
 * synchronously, so a pathological counterexample blocks the event loop and the
 * timer that would have failed the test never runs. Observed: one false property
 * over two 64-bit bigint generators ran for 98s and consumed roughly 7GB before
 * being killed from outside, while vitest reported `tests 0ms`.
 *
 * A suite that hangs is worse than one that fails, because a hang reports
 * nothing about the other tests. These limits make a failing property report a
 * counterexample in seconds instead.
 */
fc.configureGlobal({
  numRuns: 200,
  // Counted against search and shrinking together, and enforced by fast-check
  // itself rather than by a timer that a blocked event loop would never reach.
  interruptAfterTimeLimit: 10_000,
  markInterruptAsFailure: true,
});
