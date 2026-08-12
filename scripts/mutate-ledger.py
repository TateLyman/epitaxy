"""Mutation check for tests/unit/ledger.test.ts and tests/durability/recovery.test.ts.

Each mutation is a defect the suite claims to catch. Most are defects that were
ACTUALLY IN THE TREE at some point, not invented ones. A mutation that survives
means the corresponding test does not test anything.

Two files now, because P2a.1 moved the UTC-day helpers into the clock module:
the day boundary and the cadence are the same concern and had been split across
two definitions of "what time is it".
"""
import pathlib
import re
import os
import subprocess
import sys

SRC = pathlib.Path('apps/engine/src/ledger.ts')
CLOCK = pathlib.Path('packages/domain/src/clock.ts')

MUTATIONS = [
    (
        SRC,
        'M1 the original defect: the day never rolls',
        lambda s: s.replace(
            "  if (today === ledger.dayStartUtcMs) return { rolled: false, daysSkipped: 0, wentBackward: false };",
            "  if (true) return { rolled: false, daysSkipped: 0, wentBackward: false };",
        ),
    ),
    (
        SRC,
        'M2 roll zeroes the day instead of recomputing it from immutable rows',
        lambda s: s.replace(
            '  ledger.realizedTodayLamports = realizedForDay(db, today).realized;',
            '  ledger.realizedTodayLamports = 0n;',
        ),
    ),
    (
        SRC,
        'M3 the original defect: realised total summed through a double',
        lambda s: re.sub(
            r'  let total = 0n;\n  for \(const row of rows\) total \+= BigInt\(row\.r\);\n  return total;',
            '  let total = 0;\n  for (const row of rows) total += Number(row.r);\n  return BigInt(total);',
            s,
        ),
    ),
    (
        SRC,
        'M5 cutoff excludes positions closed exactly at midnight',
        lambda s: s.replace("AND closed_utc_ms >= ?", "AND closed_utc_ms > ?"),
    ),
    (
        SRC,
        'M6 the closing day is not sealed, so a skipped day leaves no record',
        lambda s: s.replace('  recordDay(\n    db,', '  if (false) recordDay(\n    db,'),
    ),
    (
        SRC,
        'M7 a backward day move is silently treated as forward',
        lambda s: s.replace(
            '  return { rolled: true, daysSkipped: skipped, wentBackward: skipped < 0 };',
            '  return { rolled: true, daysSkipped: skipped, wentBackward: false };',
        ),
    ),
    (
        SRC,
        'M8 the day total ignores the upper bound, so it counts later days too',
        lambda s: s.replace(
            "AND closed_utc_ms >= ? AND closed_utc_ms < ?",
            "AND closed_utc_ms >= ? AND closed_utc_ms < ? + 999999999999",
        ),
    ),
    (
        CLOCK,
        'M4 day boundary is local time, not UTC',
        lambda s: s.replace('setUTCHours(0, 0, 0, 0)', 'setHours(0, 0, 0, 0)'),
    ),
    (
        CLOCK,
        'M9 the UTC date key is derived from local time',
        lambda s: s.replace(
            "return new Date(utcMs).toISOString().slice(0, 10);",
            "return new Date(utcMs).toDateString();",
        ),
    ),
    (
        CLOCK,
        'M10 a cadence catches up after a stall instead of scheduling from now',
        lambda s: s.replace(
            '  fired(nowMonotonicMs: number): void {\n    this.last = nowMonotonicMs;\n  }',
            '  fired(nowMonotonicMs: number): void {\n    this.last = (this.last ?? nowMonotonicMs) + this.intervalMs;\n    void nowMonotonicMs;\n  }',
        ),
    ),
    (
        CLOCK,
        'M11 a forward wall jump is not reported as a discontinuity',
        lambda s: s.replace("  if (skewMs > thresholdMs) {", "  if (false) {"),
    ),
]

TESTS = [
    'tests/unit/ledger.test.ts',
    'tests/unit/p10-regressions.test.ts',
    'tests/durability/recovery.test.ts',
    'tests/unit/portfolio.test.ts',
]

ORIGINAL = {SRC: SRC.read_text(encoding='utf-8'), CLOCK: CLOCK.read_text(encoding='utf-8')}
unapplied, survived = [], []


def _run(tests):
    """Run the suite and return (failed_count, parseable)."""
    r = subprocess.run(
        ['npx', 'vitest', 'run', *tests, '--reporter=basic'],
        capture_output=True, text=True,
        # shell=True with a LIST argument runs only the first element on POSIX
        # and discards the rest. That is how this harness ran zero tests on
        # Linux while reporting a verdict for every mutation.
        shell=(os.name == 'nt'),
    )
    out = re.sub(r'\x1b\[[0-9;]*m', '', r.stdout + r.stderr)
    m = re.search(r'Tests\s+(\d+) failed', out)
    if m:
        return int(m.group(1)), True
    # No "N failed" line. Either everything passed, or the runner never ran.
    return 0, bool(re.search(r'Tests\s+\d+ passed', out))


def _require_clean_baseline(tests):
    """The suite must PASS, and must be parseable, before any mutation.

    Without this, a harness that cannot start the test runner reports every
    mutation as surviving -- or worse, a future refactor could make it report
    every mutation as caught. A mutation result is only meaningful relative to a
    known-green baseline, so the baseline is measured rather than assumed.
    """
    failed, parseable = _run(tests)
    if not parseable:
        print('HARNESS ERROR: could not parse a vitest result. Nothing was measured.')
        sys.exit(2)
    if failed != 0:
        print(f'HARNESS ERROR: baseline suite already has {failed} failing test(s).')
        print('A mutation result means nothing against a red baseline.')
        sys.exit(2)
    print(f'baseline green ({len(tests)} suite(s))\n')


_require_clean_baseline(TESTS)

try:
    for path, name, mutate in MUTATIONS:
        mutated = mutate(ORIGINAL[path])
        if mutated == ORIGINAL[path]:
            unapplied.append(name)
            print(f'!! {name}: PATTERN DID NOT MATCH — mutation not applied')
            continue
        path.write_text(mutated, encoding='utf-8')
        r = subprocess.run(
            ['npx', 'vitest', 'run', *TESTS, '--reporter=basic'],
            capture_output=True, text=True,
            # shell=True with a LIST argument runs only the first element on
            # POSIX and discards the rest, so vitest never ran on Linux, the
            # output never contained "Tests N failed", and EVERY mutation was
            # reported as caught-then-survived from an empty result. The harness
            # was vacuous on the platform CI runs on. Windows needs shell=True
            # to resolve npx.cmd; POSIX must not have it.
            shell=(os.name == 'nt'),
        )
        out = re.sub(r'\x1b\[[0-9;]*m', '', r.stdout + r.stderr)
        m = re.search(r'Tests\s+(\d+) failed', out)
        n = int(m.group(1)) if m else 0
        path.write_text(ORIGINAL[path], encoding='utf-8')
        if n == 0:
            survived.append(name)
            print(f'SURVIVED  {name}  <-- not covered')
        else:
            print(f'caught    {name}  ({n} failing test(s))')
finally:
    for path, original in ORIGINAL.items():
        path.write_text(original, encoding='utf-8')
    print('\nrestored both files')

if unapplied or survived:
    print(f'\nFAILED: {len(unapplied)} unapplied, {len(survived)} survived')
    sys.exit(1)
print('\nall mutations caught')
