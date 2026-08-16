# -*- coding: utf-8 -*-
import io

p = 'packages/storage/src/db.ts'
s = io.open(p, encoding='utf-8').read()

idx = s.index("    id: 38,")
close = s.index("\n];", idx)

m = '''
  {
    id: 39,
    name: 'leg_account_plans',
    sql: `
-- P2/F12 -- the EXACT plan of the bytes a leg executed.
--
-- The SDK chooses things: it selects a fee recipient from a list, appends
-- remaining accounts when cashback applies, and derives associated token
-- accounts under whichever token program the mint uses. Two builds of "the
-- same" leg are therefore not guaranteed to be the same transaction, and a
-- system that captures state for one build, simulates a second and fingerprints
-- a third is comparing three different experiments.
--
-- This is the row that makes a replay comparable to what happened, rather than
-- to what a rebuild would probably produce.
CREATE TABLE IF NOT EXISTS leg_account_plans (
  trajectory_id     TEXT NOT NULL,
  leg               TEXT NOT NULL,
  -- sha256 over programs, instruction data and ORDERED account metas. Position
  -- is part of the identity: PumpSwap reads the cashback accumulator ATA at
  -- remaining index 0, so present and present-in-the-right-place differ.
  fingerprint       TEXT NOT NULL,
  instruction_count INTEGER NOT NULL,
  -- The full plan: [{programId, data, accounts:[{pubkey,isSigner,isWritable,index}]}]
  plan_json         TEXT NOT NULL,
  program_ids       TEXT NOT NULL,
  accounts          TEXT NOT NULL,
  writable_accounts TEXT NOT NULL,
  recorded_utc_ms   INTEGER NOT NULL,
  PRIMARY KEY (trajectory_id, leg),
  FOREIGN KEY (trajectory_id) REFERENCES development_trajectories(trajectory_id)
);

CREATE INDEX IF NOT EXISTS idx_leg_plans_fingerprint ON leg_account_plans(fingerprint);
`,
  },'''

s = s[:close] + m + s[close:]
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('migration 39 added')
