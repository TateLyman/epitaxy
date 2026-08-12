# Decision log

Decisions with consequences, the alternative that was rejected, and what would make the
decision wrong. Entries are append-only.

---

### D1 — Run TypeScript directly through `tsx`; no build step, no `dist/`
**2026-08-11**

Imports are relative and carry a `.js` suffix, as ESM resolution requires.

*Rejected:* a compiled build. It adds a step between editing and running, and a stale
`dist/` is a class of bug where the code you are reading is not the code that ran. For a
system where the operator needs to trust that what they inspected is what executed, that
is a bad trade for a startup-time saving measured in tens of milliseconds.

*Wrong if:* the tree grows large enough that per-run transpilation becomes a real cost, or
a production deployment target requires a build artifact.

---

### D2 — `node:sqlite` rather than better-sqlite3
**2026-08-11**

*Rejected:* `better-sqlite3`, which is mature and not experimental.

Reason: it is a native module requiring a compile toolchain on Windows, which is exactly
the kind of environment fragility the setup phase is supposed to remove. `node:sqlite`
ships with the runtime and needs nothing. The cost is an experimental-API warning on every
run and the risk in A15.

*Wrong if:* the `node:sqlite` API changes under us, or corruption appears under sustained
write load.

---

### D3 — Token amounts persist as TEXT, not INTEGER
**2026-08-11**

SQLite's INTEGER is 64-bit **signed**. A raw token amount can exceed 2^63 — a token with 9
decimals and a large supply gets there easily — and would wrap negative on write.

*Rejected:* storing amounts as INTEGER and "being careful". Being careful is not a
mechanism.

*Wrong if:* nothing plausible. This is a property of the storage engine.

---

### D4 — Observe and paper do not import `packages/execution/`
**2026-08-11**

The claim "observe cannot trade" is enforced by the import graph rather than by a runtime
check, so it cannot be defeated by a configuration mistake.

*Rejected:* a runtime `if (mode === 'observe') return` guard. That is one deleted line
away from being false, and nothing would notice.

Reinforced by an e2e test that asserts `intents`, `execution_attempts`, `positions`, and
`fills` are empty **against the database** after a full cycle, so a future refactor that
introduced a write would fail even if it looked correct.

---

### D5 — Tokens are banked at discovery and screened later
**2026-08-11**

Discovery writes a candidate row immediately; screening happens on a later cycle once the
token has aged into the `[120s, 3600s]` window, at which point the mint is re-enriched via
`jupiter.search()`.

*Rejected:* screening at discovery. A token discovered at 10 seconds old cannot be
screened against gates defined over a two-minute-old population, and deferring the
*discovery* instead would mean the candidate universe is chosen with hindsight — which is
future-universe leakage.

Banking first also means the corpus contains every token we ever saw, not only the ones we
liked, which is what makes survivorship analysis possible at all.

---

### D6 — Rejections are stored as first-class rows
**2026-08-11**

A screening row is written for every token screened, and a decision snapshot for every
screening.

*Rejected:* storing only eligible candidates. A pipeline that keeps only its winners can
never answer whether a filter earned its place, and every filter would be unfalsifiable
forever.

The e2e suite asserts zero orphan screenings — a screening without its snapshot is a
decision that can never be re-derived.

---

### D7 — Absence of a provider field is graded as risk, never asserted as a verdict
**2026-08-11**

Applied to `organicScore` (MT001), `devBalancePercentage` (MT002), and top-holder
concentration.

Both directions were wrong. Treating absence as *bad* rejected 100% of the population the
strategy is defined over. Treating absence as *good* would admit precisely the tokens
nobody has looked at. So absence gets its own named soft-risk reason with its own weight,
and shows up in the corpus as a distinct, countable thing.

A value that is present and bad remains an unconditional refusal. The change never weakens
the rule for tokens that have data.

*Wrong if:* the absence rate for a field drops to near zero, at which point the fallback
is dead code carrying weight.

---

### D8 — Replay logic lives in `replay.ts`, not in the CLI
**2026-08-11**

Originally the entire replay implementation was inside `replay-cli.ts`, which made
`pnpm replay` reporting "0 divergences" an unfalsifiable claim: nothing tested whether the
checker could detect anything at all.

Extracting the logic made it testable against a constructed corpus. `tests/replay/`
now proves both directions — a clean corpus reproduces exactly, and a tampered corpus is
caught field by field (flipped verdict, altered score, invented veto, deleted quote,
un-replayable snapshot), while veto *reordering* correctly does not report divergence.

Related: `pnpm replay` exits non-zero when `replayed === 0`. Zero divergences over zero
rows is not evidence, and reporting it as success is how a verification quietly stops
verifying.

---

### D9 — The mode is a command-line argument, not an environment variable
**2026-08-11**

`MODE=paper pnpm paper` does nothing under cmd.exe — the inline assignment is silently
dropped, the script ran as observe, and the entry point refused to start with an error
that pointed nowhere near the cause.

*Rejected:* `cross-env`. It fixes the symptom by adding a dependency to a repository that
holds a signing key, to solve a problem better solved by not depending on the shell at all.

`modeFromArgv()` parses `--mode=` from `process.argv`, and `loadConfig(mode)` refuses a
config file whose declared mode differs from the one requested — so the command line and
`config/<mode>.json` cannot disagree silently.

*Known gap:* `pnpm doctor` still takes no mode argument and validates the default config
(O023).

---

### D10 — A false property test was corrected rather than silenced
**2026-08-11**

The test suite could not complete. One property test ran 98 seconds and consumed roughly
7 GB before being killed from outside, while vitest reported `tests 0ms`.

The available shortcuts were to raise the timeout or delete the test. Both would have
produced a green suite and left the cause in place.

Bisection found the property was **false**: `lossBps` truncates, so a one-unit change on
2^64−1 returns exactly 0, and fast-check could always find a counterexample. It shrank
*synchronously*, blocking the event loop, so `testTimeout: 20_000` could never fire — a
timeout cannot rescue a test that never yields.

Three things came out of it: the property was restated as the claim that is actually true
(the sign is never *wrong*, and is strictly non-zero above the resolution floor), the
resolution floor was documented on the production function, and `tests/setup.ts` now bounds
fast-check globally with `interruptAfterTimeLimit` so the guard lives where the blocking
happens.

*The general rule this established:* a suite that hangs is worse than one that fails,
because a hang reports nothing about any other test.

---

### D11 — Path rules use `permissions.deny`; only command *content* uses a hook
**2026-08-11**

`permissions.deny` in `.claude/settings.json` is declarative and cannot fail silently, so
it carries every path-shaped rule: `.env`, keypair patterns, SSH and cloud credential
directories, the live acknowledgement file.

A hook carries only the rules shaped like command content, where a glob is trivially
evaded — `Bash(rm -rf *)` does not match `cd /tmp && rm -rf .`, but a regex over the whole
command string does.

*The risk taken on:* a hook that crashes fails **open**, and silently. So the hook has no
dependencies, no async work, and 44 tests in `tests/unit/hook-guard.test.ts` that run the
real script as a real subprocess over real stdin — including a full set of false-positive
cases, because a guard that blocks ordinary work is a guard that gets switched off.

---

### D12 — The failure register records honest status, including gaps in this repository
**2026-08-11**

181 rows, of which 119 are `implemented`, 37 `partial`, 22 `designed_not_implemented`, and
3 `not_applicable_current_architecture`.

*Rejected:* marking rows implemented because a plausible mechanism exists somewhere. The
register's only value is that its status column can be trusted, so every fixture and owner
module referenced by a row was checked to exist before the file was committed.

Two of the honest gaps are worth naming here because they are environmental and entirely
unguarded: no clock-skew check and no sleep/resume detection.

*Amended 2026-08-11:* a read-back pass found the register wrong in the **safe** direction
on O017 — it claimed no backup existed, when `db.ts:335` does copy the database on every
non-readonly open. Moved to `partial`, because the copy is not a consistent WAL snapshot
and its failure path is an empty `catch`. Worth recording that the error was
*understating* a mechanism rather than overstating one: the register was written by
grepping for evidence a thing was absent, which finds nothing when the mechanism lives
somewhere the grep did not look. Overstating would have been the dangerous direction, but
understating is what actually happened, and the fix for both is the same — read the owner
module, do not infer from search results.
