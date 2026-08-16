import io

p = 'packages/storage/src/db.ts'
s = io.open(p, encoding='utf-8').read()

# Restore 37 to what actually ran, so the file matches applied history.
s = s.replace(
    "  refusal           TEXT,\n  -- How late the mark was relative to its due time. A mark taken long after\n  -- its horizon represents that horizon in NAME ONLY.\n  lateness_ms       INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (trajectory_id, offset_ms),",
    "  refusal           TEXT,\n  PRIMARY KEY (trajectory_id, offset_ms),",
    1,
)

idx = s.index("    id: 37,")
close = s.index("\n];", idx)

m = '''
  {
    id: 38,
    name: 'mark_lateness',
    sql: `
-- How late a mark was against its due time.
--
-- This belongs in its own migration because 37 HAD ALREADY RUN on the live
-- database. Migrations are idempotent by id, so editing an applied one changes
-- the file and not the schema -- the column silently never appears, and every
-- insert then fails with "no column named lateness_ms" against a migration
-- that reads as if it created it.
--
-- A mark taken long after its horizon represents that horizon in NAME ONLY.
-- The first live run fetched five horizons in one burst and every exit policy
-- then agreed trivially, which is why this is recorded per row rather than
-- inferred later.
ALTER TABLE trajectory_marks ADD COLUMN lateness_ms INTEGER NOT NULL DEFAULT 0;
`,
  },'''

s = s[:close] + m + s[close:]
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('migration 38 added; 37 restored to its applied form')
