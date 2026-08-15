# ADVERSARIAL AUDIT — head `74f839e`

**Final state: `MEASUREMENT_REPAIR_REQUIRED`**

Directive: `epitaxy_1c499cd_adversarial_validation_prompt_2`.
Machine-readable ledger: `artifacts/adversarial-audit-74f839e.json`.
Probes: `tests/unit/adversarial-audit-74f839e.test.ts` (19 tests, all passing).

This audit did not continue the implementation and did not repair anything it
found. Nothing was funded, signed, submitted, or run under canary or live. No
production source file was modified.

---

## 0. Ground truth, established before anything was trusted

The directive names head `1c499cd`. That is **not** the head here.

| | |
|---|---|
| Directive's named head | `1c499cdf0d2b5381f31e1ffe842eb32d16101846` |
| Actual local head | `74f839e071a9d2e911333ddc607d959695a96772` |
| Relationship | `1c499cd` is an **ancestor**; eight commits (#38–#45) land on top of it |
| Branch | `claude/new-session-91g6rp`, working tree clean |

The audit was performed against the actual head. Nothing newer was discarded.

### The environment is not the one the directive assumes

The directive asks for "the running development collector", a "WSL runtime",
and "a verified WAL-consistent backup" of the database. None of these exist.

| Fact | Value |
|---|---|
| Platform | Linux 6.18.5, **ephemeral cloud container** — not WSL |
| `wsl` binary | absent |
| `/mnt/c` | absent |
| Configured database | `./data/runtime.db` (`packages/domain/src/config.ts:482`) |
| **Database exists** | **no** |
| `.db` / `.db-wal` files anywhere on host | **zero** |
| `data/` directory contents | one `hook-decisions.log`, created at container start |
| Running collector processes | zero |
| `.env` / mainnet RPC | absent |

There was no WAL to make consistent and no corpus to back up. `data/` is
gitignored, so the container was cloned without it.

### What that costs the audit

The central question — *does the running development collector produce one
economically coherent trajectory* — **has no running collector to ask it of.**

`docs/STATUS.md` claims state `VALID_TRAJECTORY_KERNEL_RUNNING` on the strength
of "**Twenty trajectories completed**". Those twenty rows are not reachable from
this environment. I did not verify them and I did not disprove them; there is
nothing here to inspect. Under the directive's own closing rule — *"Promotion
requires current clean production rows"* — **no promotion is admissible from
this environment regardless of what the code says.**

Eight of the fourteen attack sections are therefore `NOT TESTABLE`. That is a
finding about reproducibility, not a partial pass, and §0's finding **F9** below
explains why it is worse than an accident of packaging.

### What was still possible

Real, falsifiable work against the code itself:

- baseline suite: **104 files / 1481 tests green in 30s**, typecheck clean;
- 19 adversarial probes added, **all passing**, suite now **105 / 1500**, no regressions;
- the Rust worker **built from source and ran natively on Linux** — which is itself a finding.

---

## 1. The failure ledger

Ten findings. Six are confirmed by executable probes; four by direct inspection.

### F1 — §2 — the quote-state proof is vacuous, and the sell is then priced from PRE-BUY state · **FAIL, high**

`packages/pipeline/src/sequential-round-trip.ts:201-216`, `:238-256`;
`packages/simulator/src/sequential-worker.ts:300-315`

**Mutation.** A worker whose `observe()` returns `{ accounts: [], unobserved: [POOL] }`
— the shape a real worker produces when the price-bearing accounts were never
loaded into the runtime.

**Observed.** `postSrc = overlaySource(preSrc, accountSourceOf([]))` silently
degrades to the **pre-buy** snapshot, so `buildSell` is handed pre-buy pool bytes.
`assertQuoteStateSurvived` then iterates the *empty* quoted map and throws
nothing. The trip returns `ok: true`, `failure: null`, **`quoteStateSurvived: true`**.

**Economic consequence.** This is precisely the defect P3 exists to remove: an
exit priced from a state that never contained the entry — now certified as a
proven sequential mechanic. Self-impact is understated, so round-trip drag is
understated and measured economics are systematically flattered. A silent
apparatus failure is recorded as a market fact.

The vacuity *is* documented at the assertion — `tests/unit/sequential-worker-p3.test.ts:102`,
*"an empty quote vacuously passes, which is why a caller must quote something"*.
The gap is that **the only production caller never performs the guard that
comment relies on.**

### F2 — §2 — `unobserved` is dropped, so "every required writable is observed" is unenforced · **FAIL, medium**

`sequential-round-trip.ts:176`, `:278-291`

`RoundTripResult.incompleteness` is populated from `w.initIncompleteness` only —
init-time, never per-step. With `observe` reporting `unobserved: [POOL]` and the
sell step reporting `unobserved: ['SomeWritable']`, the result carries
`incompleteness: []` and `ok: true`. A trajectory whose writables were not all
observed is indistinguishable from one that was.

### F3 — §3 — the economic drift check cannot fire on real RPC output · **FAIL, medium**

`coherent-snapshot.ts:252-256`, `:299-308`; `rpc.ts:591-625`

`captureCoherentSnapshotV2` refuses >100 economic accounts, and
`getMultipleAccountsAtSlot` assigns every account in a chunk the single
`result.context.slot` of that chunk. All economic rows therefore share one slot
and `high - low` is **0 by construction**. Probed at static slots 500, 900 and
100 000: `economicDriftSlots === 0` every time.

The frozen bound of 0 is enforced against a quantity that is always 0. The
refusal branch is dead code in production. **The logic is correct** — a probe
feeding hand-mixed per-account slots confirms it rejects — but no real input can
exercise it. Coherence rests entirely on the node's single-batch guarantee, which
is defensible; the *second, independent* check the module presents adds nothing.

### F4 — §3 — the sysvars are exempt from drift, and a mixed-slot state is accepted · **FAIL, high**

`coherent-snapshot.ts:278-295`, `:298-302`

**Mutation.** Economic batch at slot 1000, static batch at slot 1100.

**Observed.** The capture **succeeds**: `economicDriftSlots: 0`,
`captureSlotHigh: 1000`, `batchSlots: [1000, 1100]`, and **`clock.slot: '1100'`**.
The snapshot pairs pool bytes true at slot 1000 with a Clock true at slot 1100.

**Economic consequence.** The directive states the capture *"may not stamp one
slot over a mixed state."* It does exactly that, for time. The Clock's
`unixTimestamp` initialises the replayed LiteSVM runtime, and PumpSwap's
`UserVolumeAccumulator` is **time-windowed** — so a Clock from a different slot
can move a simulated trade into a different fee/cashback window. The module's
rationale for the static tier is that such accounts "cannot change the
arithmetic"; for a protocol with time-dependent fee state that is not obviously
true.

The drift is *recorded* in `batchSlots`, so this is auditable after the fact
rather than concealed. It is simply not enforced.

### F5 — §3 — removal yields a note and a usable snapshot; the fee config falls back to a default by name · **FAIL, medium**

`coherent-snapshot.ts:327-329`, `:357-360`, `:373-375`

Each of Clock, Rent, fee config and the economic pool was removed in turn. **Every
removal returned a snapshot with a valid `snapshotHash`:**

| Removed | Result |
|---|---|
| Clock | `clock: null` + `"the Clock sysvar was not captured"` |
| Rent | `rent: null` + note |
| Fee config | `feeConfigHash: null` + **`"...so the tier is the program default"`** |
| Economic pool | `omissions: [pool]`, snapshot still produced |

The directive requires each to *"produce a named refusal, never a default."* The
fee-config path is a default **in the code's own words**, and the fee tier
determines the cost of every simulated trade built on that snapshot. Refusal is
delegated to whichever consumer remembers to inspect `clock === null`,
`feeConfigHash === null` and `omissions` — fail-**open** at this layer, against
the repository invariant "Fail closed."

Mitigating: naming an account in `requireDecodable` *does* produce a named
refusal for absence (confirmed). The gap is that this is opt-in per call site
rather than structural.

### F6 — §3 — `requireDecodable` does not decode · **FAIL, medium**

`coherent-snapshot.ts:310-319`

Eleven bytes of ASCII garbage (`not-a-pool!`) in the pool account, with the pool
named in `requireDecodable`: **the capture succeeds** and stores the garbage
verbatim. The gate tests presence and `dataBase64.length !== 0`; it never
attempts a decode.

The module header states *"an account that is present but undecodable refuses the
snapshot"* and *"a partially interpreted pool is the shape that produces a
confident wrong price."* A corrupt-but-nonempty pool passes the check named after
that guarantee.

Corrupt **sysvars** and **ALTs** do refuse correctly — `decodeClock`, `decodeRent`,
`decodeEpochSchedule` and `decodeLookupTableAddresses` all throw
`SnapshotIncoherent` on a bad length. The gap is specific to `requireDecodable`.

### F7 — §7 — the exit tournament is one-sided by construction · **FAIL, medium**

`treatments.ts:255-262`

The directive requires a counterexample where *deterioration holds while
fixed-time exits at horizon*. **It is not constructible.**
`FLOW_LIQUIDITY_DETERIORATION_V1` falls back to the identical `FIXED_HORIZON_MS`
whenever no deterioration fires, returning the same `triggeredAtMs` as the
control.

The two policies are therefore identical on every path where the challenger does
not exit early. The tournament can measure only *"exit sooner"*, never *"hold
longer"*. Since memecoin returns are heavy-tailed and the module's own comment
says the right tail carries the result, a tournament structurally incapable of
testing a longer hold **cannot discover that exiting early is the error.** The
paired comparison is valid; its support is one-sided.

This is a consequence of the deliberate anti-survivorship fallback, not a coding
error. It is recorded because it bounds what the tournament can conclude.

### F8 — §7 — a null mark hides a real collapse · **FAIL, low**

`treatments.ts:238-253`

Exit capacity `1,000,000 → null → 500,000` yields `triggeredAtMs: null`. The loop
`continue`s when either side of an **adjacent** pair is null, so the 50% collapse
spanning the gap is never compared. One unmeasured mark suppresses the exit
signal across it, and the position is held through a halving of exit capacity.
Treating the gap as "no deterioration" is the null-is-safe reading the repository
invariant explicitly forbids.

### F9 — §0 — the runtime is unrunnable off Windows, although the worker is portable · **FAIL, medium**

`sequential-runtime.ts:112`, `:163`; `sequential-worker.ts:107-111`

Both entry points spawn the literal command:

```
wsl -d Ubuntu-24.04 -- /mnt/c/Users/lyman/tradseee/offline-worker/target/release/epitaxy-offline-worker
```

`WorkerOptions.workerPath` can change the path but **not** the `wsl` wrapper.

I built the worker from the checked-in Rust source with `cargo build --release`
and ran it natively:

```
sha256  8b68c8fa6e17595c0273a93ffde24a35fde05d84b836a2b563950a8e886397e5
echo '{"cmd":"close"}' | ./epitaxy-offline-worker --serve  →  {"ok":true}
```

**The worker is portable. The client is not.** The WSL dependency is an
unnecessary lock, not a technical requirement.

**Consequence.** Every artifact the trajectory kernel produced is reproducible
only on one developer's Windows machine. An independent auditor cannot re-derive
a single trajectory — the first thing this directive asks for. The invariant
"Every decision is re-derivable from its snapshot" is unenforceable off that
host, and the binary hash the worker self-reports cannot be checked against an
independent build. This is what converts most of this audit into `NOT TESTABLE`.

### F10 — §14 — lamport bigints cross `Number` on the readiness path · **FAIL, low**

`readiness.ts:515-516`, `:476-481`

`strategyNetLamports: Number(net)` and `canaryShadowNetLamports: Number(canaryShadowNet)`
convert lamport totals to doubles; the single-trade and single-day profit-share
gates compute `Number(a) / Number(b)` on lamport bigints.

CLAUDE.md: *"bigint for every token amount. Never a float for lamports."* Totals
above 2^53 (~9.0 M SOL) lose integer precision. At current notionals that
headroom is not threatened, so this is an invariant violation with no present
numerical impact — but it sits on the path where the directive specifically
demands that a sample "positive only under unsafe bigint conversion" be rejected.

Not load-bearing everywhere: `readiness.ts:303` does the bigint arithmetic
**first** and converts only the resulting bps — the correct pattern, and evidence
the codebase knows it.

---

## 2. Section verdicts

| § | Attack | Verdict |
|---|---|---|
| 1 | Reconstruct one trajectory | **NOT TESTABLE** — no rows exist |
| 2 | Sequential-state claim | **FAIL** — F1, F2 |
| 3 | Snapshot coherence | **FAIL** — F3, F4, F5, F6 |
| 4 | Cashback accounting | **NOT TESTABLE** |
| 5 | Settlement identity | **NOT TESTABLE** |
| 6 | Later-fill identity | **NOT TESTABLE** |
| 7 | Policy treatments | **PASS WITH FINDINGS** — F7, F8 |
| 8 | Event/migration source | **PASS** (source) / NOT TESTABLE (live tx) |
| 9 | Counterfactual future marks | **PASS** (type) / NOT TESTABLE (runtime) |
| 10 | Sampling and inference | **NOT TESTABLE** |
| 11 | WSS protection | **NOT TESTABLE** |
| 12 | Parity authorization | **NOT TESTABLE** |
| 13 | Rate and artifact reports | **NOT TESTABLE** |
| 14 | Readiness | **NOT TESTABLE** — F10 by inspection |

### What survived the attack

Not everything failed, and the passes are load-bearing.

**§2, partially.** Mutating a pool/vault account between quote and execution
**does** fail the trip with `QUOTE_STATE_MOVED`. An account that was quoted and
is absent at execution is correctly treated as moved. The worker keeps one
runtime and `observe()` is ordered strictly between buy and sell. The mechanism
is right; F1 is a hole in its *precondition*, not its logic.

**§7.** The tournament is genuine, not relabelling — four of five required
counterexamples were constructed and confirmed: `HARD_GATES_RANDOM` enters where
quality rejects; quality enters where survivor-flow rejects; survivor-flow enters
where quality rejects; deterioration exits early where fixed-time holds. Hard
gates bind every policy identically, and an unknown feature is never read as a
pass. `seededInclusion` is deterministic in `(seed, mint)` via sha256 and
`Math.random()` is correctly absent.

**§8.** `packages/solana/src/migration.ts` derives identity from canonical
structure, not log strings. Failed transactions are refused outright (`:152`).
An 8-byte discriminator check rejects swaps against the same pool. The mint's
PDA-derived pool must independently appear in the transaction's account keys.
The instruction's **own** accounts are searched before transaction-wide token
balances — with a comment recording that the reverse order previously
misattributed the second migration in a two-migration transaction. Dedup is keyed
on `(signature, instructionIndex, programId)`, so two events in one transaction
remain two. `mint == pool` cannot be hit accidentally, because `pool` is a PDA
derivation that must independently appear in `accountKeys`.

**§9.** The required classification exists as `BOUNDED_COUNTERFACTUAL` and
`FULL_EVENT_REPLAY` (`packages/domain/src/trajectory-evidence.ts:39-53`), applied
at `trajectory-kernel.ts:202-208` and gated at `:291`. The directive's exact
spellings carry a `_TRAJECTORY` suffix that does not appear; the concepts do.

**§12.** No global `PumpSwap parity=true` flag exists — searched for and not
found, which is the right sign. `readiness.ts:489` requires exactly one distinct
simulator fingerprint across the corpus.

**Invariants upheld.** Observe and paper do not import `packages/execution`. No
live acknowledgement file was created. The tree was clean at start and no
production source was modified. Suite green before and after.

---

## 3. Final state

```
MEASUREMENT_REPAIR_REQUIRED
```

Two independent grounds, either sufficient:

1. **Confirmed measurement defects.** F1 lets an exit priced from pre-buy state
   be certified as a proven sequential mechanic. F4, F5 and F6 let a snapshot
   that is mixed-slot, missing its fee config, or holding a corrupt pool be
   accepted as coherent. These are exactly the class of defect that produces
   confident wrong numbers.

2. **No promotion is admissible regardless.** The directive requires current
   clean production rows. This environment has no database at all.

`VALID_TRAJECTORY_KERNEL_RUNNING`, as claimed in `docs/STATUS.md`, is not
supported by any evidence reachable from here. I make no claim that the twenty
trajectories are wrong — only that nothing in this environment can confirm them,
and that F1 describes a path by which such a trajectory could be recorded as
proven while being priced from a state that never contained its entry.

**No failing invariant was repaired during this audit.** The probe file records
the failing baseline. Fixes belong in separate commits, after which the audit
must be rerun from scratch — and, per F9, rerun somewhere it can actually
execute the runtime.

### Suggested repair order

1. **F1** — refuse the trip when `quoted.accounts` is empty or any
   `priceBearingAccount` lands in `unobserved`. One guard closes the highest-severity finding.
2. **F9** — drop the `wsl` wrapper when not on Windows. Without this, no
   independent party can ever verify the repair to F1.
3. **F5/F6** — make refusal structural: decode what `requireDecodable` names, and
   refuse rather than default on an absent fee config.
4. **F4** — either move the sysvars into the economic batch or justify, in
   writing, why a time-windowed fee accumulator is insensitive to Clock drift.
5. **F8, F7, F10** — null-handling, tournament support, and the bigint boundary.
