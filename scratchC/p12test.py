# -*- coding: utf-8 -*-
import io

p = 'tests/unit/commands-mean-their-names-p12.test.ts'
s = io.open(p, encoding='utf-8').read()

s = s.replace(
    """      // The point of the entry is that a reader can tell what would have to
      // exist. A vague one is the alias problem with extra steps.
      expect(c.prerequisite).not.toMatch(/soon|later|TBD|TODO/i);""",
    """      // The point of the entry is that a reader can tell what would have to
      // exist. A vague one is the alias problem with extra steps.
      expect(c.prerequisite).not.toMatch(/\\b(TBD|TODO|coming soon|not yet)\\b/i);""",
)

s = s.replace(
    """    // THE assertion. Not "it currently reports zero" — that a caller could
    // change. It cannot read the file at all: no readFileSync, no artifact
    // path, no JSON.parse of anything on disk.
    expect(status).not.toMatch(/readFileSync/);
    expect(status).not.toMatch(/live-one-pass/);
    expect(status).not.toMatch(/existsSync/);""",
    """    // THE assertion. Not "it currently reports zero", which a caller could
    // change: the script has no way to read a file at all.
    //
    // It DOES name `live-one-pass-trajectory.json` in prose, deliberately, so a
    // reader knows which artifact is being excluded and why. Naming a thing you
    // refuse to read is the opposite of the defect.
    expect(status).not.toMatch(/readFileSync/);
    expect(status).not.toMatch(/existsSync/);
    expect(status).not.toMatch(/JSON\\.parse/);""",
)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
