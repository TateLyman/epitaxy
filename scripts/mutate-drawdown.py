"""Mutation check for the drawdown halt (portfolio.ts) and peakNav (ledger.ts)."""
import pathlib
import re
import os
import subprocess
import sys

PORT = pathlib.Path('packages/strategy/src/portfolio.ts')
LEDG = pathlib.Path('apps/engine/src/ledger.ts')

TESTS = ['tests/unit/ledger.test.ts', 'tests/unit/portfolio.test.ts',
             'tests/property/sizing.property.test.ts']

MUTATIONS = [
    (PORT, 'D1 the original defect: drawdownHaltPct read by nothing',
     lambda s: re.sub(
         r'  if \(risk\.drawdownHaltPct > 0 && state\.peakNavLamports > 0n\) \{',
         '  if (false) {',
         s)),
    (PORT, 'D2 halt compares against starting NAV instead of peak',
     lambda s: s.replace(
         '    const drawdown = state.peakNavLamports - state.navLamports;',
         '    const drawdown = 0n;')),
    (PORT, 'D3 off-by-one at the boundary (> instead of >=)',
     lambda s: s.replace('    if (drawdown >= limit) {', '    if (drawdown > limit) {')),
    (PORT, 'D4 halt placed after the score gate, masking the real reason',
     lambda s: s.replace(
         "  if (opportunityScore < config.minOpportunityScore) {\n    return refuse('score_below_threshold'",
         "  if (opportunityScore < config.minOpportunityScore + 1) {\n    return refuse('score_below_threshold'")),
    (LEDG, 'P1 peak tracks the latest NAV rather than the maximum',
     lambda s: s.replace('    if (nav > peak) peak = nav;', '    peak = nav;')),
    (LEDG, 'P2 peak replayed in insert order rather than close order',
     lambda s: s.replace(
         "'SELECT realized_lamports AS r FROM positions WHERE realized_lamports IS NOT NULL ORDER BY closed_utc_ms',",
         "'SELECT realized_lamports AS r FROM positions WHERE realized_lamports IS NOT NULL ORDER BY rowid',")),
]

FILES = {PORT: PORT.read_text(encoding='utf-8'), LEDG: LEDG.read_text(encoding='utf-8')}
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
