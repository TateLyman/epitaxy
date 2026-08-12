"""Mutation check for the P2a.1 halt work: the four risk halts and halt modes."""
import pathlib
import re
import os
import subprocess
import sys

PORT = pathlib.Path('packages/strategy/src/portfolio.ts')
HALT = pathlib.Path('packages/domain/src/halt.ts')

TESTS = ['tests/unit/riskenforcement.test.ts', 'tests/unit/halt.test.ts',
             'tests/unit/portfolio.test.ts', 'tests/unit/ledger.test.ts',
             'tests/unit/p16-repair.test.ts']

MUTATIONS = [
    (PORT, 'H1 the original defect: dailyLossHaltPct read by nothing',
     lambda s: s.replace('if (risk.dailyLossHaltPct > 0 &&', 'if (false &&')),
    (PORT, 'H2 the original defect: weeklyLossHaltPct read by nothing',
     lambda s: s.replace('if (risk.weeklyLossHaltPct > 0 &&', 'if (false &&')),
    (PORT, 'H3 the original defect: maxAggregatePlannedLossPct read by nothing',
     lambda s: s.replace('  if (risk.maxAggregatePlannedLossPct > 0) {', '  if (false) {')),
    (PORT, 'H7 the aggregate cap ignores the trade being proposed',
     lambda s: s.replace('    const total = state.plannedLossLamports + proposed;',
                         '    const total = state.plannedLossLamports;')),
    (PORT, 'H8 planned loss falls back to the stop instead of the catastrophic floor',
     lambda s: s.replace('  return Math.max(nominal, observed, floor);', '  return nominal;')),
    (PORT, 'H9 a measured severe loss cannot tighten sizing',
     lambda s: s.replace('  return Math.max(nominal, observed, floor);', '  return Math.max(nominal, floor);')),
    (PORT, 'H4 a zero threshold halts everything instead of disabling the halt',
     lambda s: s.replace('if (risk.dailyLossHaltPct > 0 &&', 'if (risk.dailyLossHaltPct >= 0 &&')),
    (PORT, 'H5 daily halt reads the weekly window',
     lambda s: s.replace('-state.realizedTodayLamports >= pctOfNav(risk.dailyLossHaltPct)',
                         '-state.realizedWeekLamports >= pctOfNav(risk.dailyLossHaltPct)')),
    (PORT, 'H6 off-by-one at the halt boundary',
     lambda s: s.replace('-state.realizedTodayLamports >= pctOfNav(risk.dailyLossHaltPct)',
                         '-state.realizedTodayLamports > pctOfNav(risk.dailyLossHaltPct)')),
    (HALT, 'K1 the original defect: a halt terminates regardless of exposure',
     lambda s: re.sub(r'export function mayTerminate\(mode: HaltMode, openPositions: number\): boolean \{',
                      'export function mayTerminate(mode: HaltMode, openPositions: number): boolean {\n  return true;',
                      s)),
    (HALT, 'K2 a bare halt file defaults to the mode that can orphan a position',
     lambda s: s.replace("const DEFAULT_MODE: HaltMode = 'TERMINATE_WHEN_FLAT';",
                         "const DEFAULT_MODE: HaltMode = 'EMERGENCY_RECONCILE';")),
    (HALT, 'K3 exit management stops under every halt mode',
     lambda s: s.replace("return mode !== 'EMERGENCY_RECONCILE';", 'return false;')),
    (HALT, 'K4 an unreadable halt file is treated as no halt',
     lambda s: s.replace("      return { path, mode: DEFAULT_MODE, defaulted: true, rawLabel: null };",
                         '      return null;')),
]

FILES = {PORT: PORT.read_text(encoding='utf-8'), HALT: HALT.read_text(encoding='utf-8')}
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
        mutated = mutate(FILES[path])
        if mutated == FILES[path]:
            unapplied.append(name)
            print(f'!! {name}: PATTERN DID NOT MATCH')
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
        path.write_text(FILES[path], encoding='utf-8')
        if n == 0:
            survived.append(name)
            print(f'SURVIVED  {name}  <-- not covered')
        else:
            print(f'caught    {name}  ({n} failing test(s))')
finally:
    for path, original in FILES.items():
        path.write_text(original, encoding='utf-8')
    print('\nrestored both files')

if unapplied or survived:
    print(f'\nFAILED: {len(unapplied)} unapplied, {len(survived)} survived')
    sys.exit(1)
print('\nall mutations caught')
