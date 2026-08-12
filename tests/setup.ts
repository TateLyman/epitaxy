import fc from 'fast-check';

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
