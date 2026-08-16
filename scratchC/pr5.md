The SDK **chooses** things. It selects a fee recipient from a list, appends remaining accounts when cashback applies, and derives associated token accounts under whichever token program the mint uses. Two builds of "the same" leg are not guaranteed to be the same transaction, and a system that captures state for one build, simulates a second and fingerprints a third is comparing three experiments while reporting one.

## The plan

Frozen from the same instruction array that gets encoded — not a rebuild, not a re-derivation. It carries ordered account metas, instruction data and every program invoked. **Position is part of the identity**, because PumpSwap reads the cashback accumulator ATA at remaining index 0: *present* and *present in the right place* are different facts.

## What checking it against the snapshot found

The snapshot was assembled from `swapAccountAddresses`, which **re-derives** what it believes the leg will use. On live pools the built instruction touched **fifteen accounts derivation never predicted**.

None of them would have failed loudly. An account absent from the runtime executes as uninitialised and answers with an error that reads as a fact about the token.

They are fetched now rather than guessed at a second time. This is a second *read*, not a second *capture* — the coherent snapshot's price-bearing accounts are untouched and only accounts the plan named are added. Those are fee recipients, ATAs and programs, none of which bear price, which is the same boundary the drift bound already draws. Executables go back through the program path, because an executable restored with `set_account` populates no program cache and every route through it then fails with an invalid-program error.

An account still missing after the fetch **does not exist on chain**. That is a fact, not a failure: the transaction is about to create it, and the creation is exactly the cold-setup cost P6 exists to measure. Recorded as incompleteness rather than refused.

## F11 — the fee config that degraded silently

Three call sites caught a decode failure and substituted `null`. *No dynamic fee config exists* and *the config exists and this build cannot read it* are opposite facts, and `null` merges them into the first — the pricing that follows is computed against the static tier while the chain charges the dynamic one. All three refuse now.

## Append-only

Recording the same plan twice is a retry. Recording a **different** plan under the same identity is a rebuild, and letting it through would redefine what the earlier execution was, after the fact and without a trace.

## Evidence

A real plan, persisted from a live open:

```
leg buy | instructions 6 | fingerprint a7710c585ad0
programs : ATokenGPvbdG…, 1111…1111, TokenkegQfeZ…, pAMMBay6oceH…
accounts : 26, of which writable 10
```

The collector opened two trajectories with the check live, and the acquired amounts are **identical** to before the extra accounts were fetched — the fetch changed the apparatus, not the mechanics.

```
typecheck   clean
secretscan  clean
tests       1,548 passed, 4 skipped, 108 files  (12 new)
```

Nothing funded, signed or submitted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

---

# P12 — the commands mean their names, or they refuse

Five commands were **aliases for other scripts**: `rate:budget-v2` and `reject:panel-v2` both ran the trajectory status, `wss:status` ran the direct-signal status, `landed:parity-v2` ran a *non*-landed parity script, `exploration:status` ran the cohort status.

An alias is worse than a missing command. A missing command is noticed the first time somebody runs it. An alias produces well-formatted output about something else, exits zero, gets pasted into a status document, and becomes evidence for a capability that was never built.

Each now names its exact missing prerequisite and exits non-zero — and not vaguely:

- **`landed:parity-v2`** — no direct PumpSwap swap has ever been landed by this system, because nothing here has signed or submitted. It cannot mean its name before a canary.
- **`reject:panel-v2`** — `reject_tracking` records *that* a token was rejected, not the state it was rejected on, and a panel scored from state fetched later is a different experiment.

An unknown command name is itself refused with exit 2, so the stub cannot quietly absorb a typo.

## `trajectory:status` reads the database and nothing else

No `readFileSync`, no `existsSync`, no `JSON.parse` — the assertion is that the script *cannot* read a file, not that it currently reports zero. Proof artifacts are counted as zero **explicitly**, because silence is indistinguishable from having forgotten them. The old position-oriented status keeps its own name as `development:status`.

Two scripts were writing `artifacts/trajectory-status.json`, which breaks P12's own one-command-one-output rule: the last to run decided what the file meant and neither said so. The database status owns that name; the wider generator writes `artifacts/evidence-status.json`.

## The corpus, as the database has it

```
database trajectories : 43 (15 settled)
frozen account plans  : 5
marks by horizon        1m  40  backfilled 27
                        5m  38  backfilled 11
                       15m  32  backfilled  8
                       30m  27  backfilled  4
                       60m  15  backfilled  4
timely complete paths : 8
```

The daemon running continuously is visible here: 60-minute marks are now **11 of 15 timely**, against 0 of 4 when every horizon was fetched in one burst.

```
tests  1,557 passed, 4 skipped, 109 files
```
