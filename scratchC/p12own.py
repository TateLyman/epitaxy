# -*- coding: utf-8 -*-
import io

# ---- the multi-artifact generator stops claiming the trajectory status ------
p = 'scripts/trajectory-status.ts'
s = io.open(p, encoding='utf-8').read()
old = "writeFileSync('artifacts/trajectory-status.json', JSON.stringify(trajectoryStatus, null, 2) + '\\n');"
new = (
    "// P12 — one command, one output. `artifacts/trajectory-status.json` belongs\n"
    "// to `pnpm trajectory:status`, which reads the database and nothing else.\n"
    "// This generator produces a WIDER evidence view, so it writes under its own\n"
    "// name: two scripts writing one file means the last one to run decides what\n"
    "// the file meant, and neither of them says so.\n"
    "writeFileSync('artifacts/evidence-status.json', JSON.stringify(trajectoryStatus, null, 2) + '\\n');"
)
assert s.count(old) == 1
s = s.replace(old, new)
s = s.replace("console.log('wrote artifacts/trajectory-status.json')", "console.log('wrote artifacts/evidence-status.json')")
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok', p)

# ---- the wiring test asserts the NEW shape, with the same intent ------------
p = 'tests/unit/collector-wiring-29c7cc7.test.ts'
s = io.open(p, encoding='utf-8').read()
old = """  it('a proof artifact cannot increase the database trajectory count', () => {
    // The artifact may exist and may be entirely correct about what it
    // measured. It is still not a row.
    const status = existsSync('artifacts/trajectory-status.json')
      ? (JSON.parse(readFileSync('artifacts/trajectory-status.json', 'utf8')) as Record<string, unknown>)
      : null;
    if (status === null) return;
    const fromDb = status['developmentTrajectoryRowsSettled'];
    const fromArtifact = status['completedRoundTripsFromLiveRun'];
    // They are reported as DIFFERENT fields, and the settled count is the
    // database's answer alone.
    expect(fromDb).not.toBe(undefined);
    expect(fromArtifact).not.toBe(fromDb);
  });"""

new = """  it('a proof artifact cannot increase the database trajectory count', () => {
    // The artifact may exist and may be entirely correct about what it
    // measured. It is still not a row.
    const status = existsSync('artifacts/trajectory-status.json')
      ? (JSON.parse(readFileSync('artifacts/trajectory-status.json', 'utf8')) as Record<string, unknown>)
      : null;
    if (status === null) return;

    // P12 — the settled count is the DATABASE's answer, and the proof
    // artifacts are counted separately and explicitly as zero. Reporting them
    // in one number is the substitution; reporting them in two fields, one of
    // which is always zero, is the correction.
    const db = status['trajectories'] as Record<string, unknown> | undefined;
    expect(db?.['settled']).not.toBe(undefined);
    expect(status['proofArtifactsCounted']).toBe(0);
    expect(status['proofArtifactsCounted']).not.toBe(db?.['settled']);
  });"""

assert s.count(old) == 1
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new))
print('ok', p)
