The collector now runs continuously. **It is started and cycling.**

## P14 — daemon

The mark-and-settle pass was already resumable: every invocation marks whatever is due and settles whatever is complete, and all its state lives in the database. So a daemon is that pass on a timer — no resident scheduler, no in-memory queue, and a restart loses nothing but the current sleep.

That is what makes a horizon real. A path only produces a genuine 60-minute mark if something is alive to take it at sixty minutes. The first live run settled eight paths whose marks were all fetched in one burst — five labels, one instant.

A cycle that throws does **not** kill the daemon. An apparatus failure is a fact about that cycle; stopping on it would silently end collection at the first RPC hiccup, which reads later as *the market produced nothing* rather than *we stopped looking*.

`--once` remains the single-pass escape hatch; looping is now the default, because a collector that only runs when someone types the command is the shape this whole directive exists to correct.

## The migration defect it immediately found

I added `lateness_ms` to migration **37 after 37 had already run** on the live database. Migrations are idempotent by id, so editing an applied one changes the file and not the schema — the column silently never appeared, and every mark insert failed with `no column named lateness_ms` against a migration that reads as if it created it.

37 is restored to the form that actually ran; **38** adds the column.

Found because the daemon logged `cycle 1 failed` and kept going — the error handling doing exactly what it was written for.

## Running now

```
cycle 1: 8 marks taken, 1 settled, no failures
totals : 48 marks, 18 outcomes, 9 settled
```

Five-minute cycles, so 60-minute horizons get marked on time rather than backfilled.

## Safety

The process owns no NAV, opens no capital-bearing positions, imports no signer, and refuses to start in canary or live.

```
typecheck   clean
secretscan  clean
tests       1,517 passed, 4 skipped, 106 files
```

Nothing funded, signed or submitted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
