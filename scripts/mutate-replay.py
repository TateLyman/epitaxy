"""Mutation check for concentration capture and the unverifiable accounting (O042)."""
import pathlib
import re
import os
import subprocess
import sys

SCREEN = pathlib.Path('packages/strategy/src/screen.ts')
REPLAY = pathlib.Path('packages/research/src/replay.ts')

TESTS = ['tests/replay/determinism.test.ts']

MUTATIONS = [
    (SCREEN, 'C1 the original defect: concentration never captured',
     lambda s: re.sub(
         r'      concentration:\n        concentration === null\n          \? null\n          : \{\n'
         r'              topWalletPct: concentration\.topWalletPct,\n'
         r'              topTenWalletPct: concentration\.topTenWalletPct,\n'
         r'              programControlledPct: concentration\.programControlledPct,\n'
         r'            \},\n',
         '',
         s)),
    (SCREEN, 'C2 captured as always-null, losing the measurement',
     lambda s: re.sub(
         r'      concentration:\n        concentration === null\n          \? null\n          : \{\n'
         r'              topWalletPct: concentration\.topWalletPct,\n'
         r'              topTenWalletPct: concentration\.topTenWalletPct,\n'
         r'              programControlledPct: concentration\.programControlledPct,\n'
         r'            \},\n',
         '      concentration: null,\n',
         s)),
    (REPLAY, 'R1 the original defect: replay re-decides against null',
     lambda s: s.replace('    raw.concentration ?? null,\n', '    null,\n')),
    (REPLAY, 'R2 unverifiable rows counted as passes',
     lambda s: s.replace('  const current = atVersion.filter(replayable);', '  const current = atVersion;')),
    (REPLAY, 'R3 unverifiable rows hidden inside the version-skip count',
     lambda s: s.replace('    skippedOtherVersion: rows.length - atVersion.length,',
                         '    skippedOtherVersion: rows.length - current.length,')),
    (REPLAY, 'R4 replayable excludes every row that lacks the key, verifying less',
     lambda s: s.replace("    if ('concentration' in raw) return true;\n"
                         "    const gates = JSON.parse(row.gates_json) as { gate?: string }[];\n"
                         "    return !gates.some((g) => g.gate === 'holder_concentration');",
                         "    return 'concentration' in raw;")),
    (REPLAY, 'R5 a corrupt row is swallowed as unverifiable instead of reported',
     lambda s: s.replace('  } catch {\n', '  } catch {\n    return false;\n    // eslint-disable-next-line\n')),
]

FILES = {SCREEN: SCREEN.read_text(encoding='utf-8'), REPLAY: REPLAY.read_text(encoding='utf-8')}
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
