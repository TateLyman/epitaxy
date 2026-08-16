# -*- coding: utf-8 -*-
import io

p = 'apps/collector/src/trajectory-collect.ts'
s = io.open(p, encoding='utf-8').read()

s = s.replace('  insertTrajectory,', '  insertTrajectory,\n  insertAccountPlan,\n  accountPlanCount,', 1)

old = """      const t = res.trajectory;
      insertTrajectory(db, {"""
new = """      const t = res.trajectory;
      // P2/F12 — the plan goes in FIRST, keyed by the trajectory it belongs to.
      //
      // The capability fingerprint below is the snapshot hash, which says what
      // the market looked like. It does not say which fee recipient the SDK
      // picked or what the instruction's account order was, and those are the
      // things a replay has to reproduce exactly.
      insertTrajectory(db, {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# after insertTrajectory(...) call, add the plan write. Find the closing of the call.
anchor = "        exitPolicy: 'FIXED_15M_CONTROL',"
i = s.index(anchor)
# find the end of the insertTrajectory statement: the next "});" at that indent
j = s.index('\n      });', i) + len('\n      });')
s = s[:j] + """

      insertAccountPlan(db, t.trajectoryId, t.entryPlan, Date.now());""" + s[j:]

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
