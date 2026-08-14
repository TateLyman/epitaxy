# Final report — 3bc708d true-stateful directive

## 1. SHAs

| | |
|---|---|
| starting (audited master) | `3bc708d8ef6083989087efeb3158b34ea51ac799` |
| ending | see `git log --oneline 3bc708d..HEAD` |

Local was **identical** to audited head at session start: clean tree, no
unpushed work, 0/0 against `origin/master`.

Commits: `b989b88` baseline · `450a812` invalidation + bounded pipeline ·
`c9d2e0b` sequential runtime · `07c7bb9` cohorts/exploration/version ·
`7d1fefc` settlement field contract · `95cb61c` real buys commit ·
`9c573fb` alarm + confirmatory v3 · `3d62acd` drawdown + provenance ·
`7c8e0cf` report · `f3c745e` the sell leg · `4269963` mint facts in every mode ·
`6a1e34a` size surface, parity matrix, reject panel, rate budget

## 2. Backup

```
path       data/backups/baseline-3bc708d-2026-08-14T03-43-23-247Z.db
bytes      5,960,482,816
sha256     2c3f2d099d13d43fd42aeb550f877569e5928c47056047229478faf79bebd6ed
integrity  ok        fk 0 violations
mismatch   none — every table count on the copy equals the original
witness    0 positions holding tokens
```

Every figure read back **from the copy**. `artifacts/baseline-3bc708d.json`.

## 3. The audit stopped the engine before the backup

The direct event stream added in the previous directive was destroying the
corpus it was meant to inform:

```
1,055 events/second      6,981,407 rows in 111 minutes
91,000,000 rows/day      2.97 GB -> 6.15 GB in one session
68% UNKNOWN              43 migration events of decision-useful yield
```

## 4. Invalidated: the "stateful" proof — DONE

`docs/3BC708D_PROOF_INVALIDATION.md`. Reclassified
`LINKED_LEG_INSTRUMENT_DEVELOPMENT`.

The directive's claim is correct and my own code comment was the tell. It said
*"THE STATEFUL CARRY — the sell starts from the SOL the buy LEFT"*: true, and
the wrong half. Wallet inventory carried; pool reserves, virtual quote reserves,
creator and protocol accounts, the volume accumulator and the fee config were
re-fetched from mainnet, and the sell **route** was chosen against a pool with
its pre-buy depth.

The atom cliff is retired as non-portable — raw atoms move with decimals, supply
and price, so a threshold on one is a threshold on three unrelated things.

## 5. The sequential runtime — BUILT AND PROVEN

`packages/simulator/src/sequential-runtime.ts`, `offline-worker/`,
`artifacts/sequential-runtime-proof.json`, `docs/OFFLINE_LITESVM_PARITY.md`.

The worker takes a **list** of steps and commits each. It loads real ELF via
`add_program` — the previous version called `set_account(executable = true)` and
called that program loading, which populates no program cache — restores `Clock`
at the snapshot's slot, and stops the sequence when a step fails.

Proven on arithmetic nobody can dispute — a plain SOL transfer, no program, no
pool, no route:

| | B before | B after |
|---|---|---|
| step 1: A→B 1 SOL | 0 | 1,000,000,000 |
| step 2: A→B 2 SOL | **1,000,000,000** | 3,000,000,000 |

Two fresh states would have shown 0 → 2,000,000,000, which is precisely the
linked-leg defect.

LiteSVM stays at 0.6.1, verified rather than assumed: 0.15.2 and 0.14.0 both
fail to compile against their own resolved crate sets.

## 6. The sell is built from the buy-mutated pool — DONE

`packages/solana/src/pumpswap-offline.ts`,
`artifacts/true-stateful-roundtrip-proof.json`,
`docs/TRUE_STATEFUL_ROUNDTRIP_PROOF.md`.

The module makes the account source a **parameter**. Every field of the official
SDK's swap state comes from account bytes and nothing else, so the runtime's
committed post-buy bytes feed the official builder directly. Reads are
synchronous and total: a missing vault is an error naming the vault, never a
zero that would price a sell against an empty pool.

A Jupiter sell was refused on principle. A router prices against current mainnet
and cannot see a pool a hypothetical buy just moved, so its sell would be chosen
— route, size and minimum output — against depth that no longer exists.

**The classification is code.** `packages/domain/src/statefulness.ts` tracks two
provenances, because either alone breaks the claim: an exit that *executed* on
committed state but was *priced* on mainnet is still `LINKED_FRESH_STATE_LEGS`.

Three defects found by running it:

| symptom | cause |
|---|---|
| `AddressLookupTableNotFound` on every routed buy | the lookup **tables** were never captured, only the addresses inside them |
| `InstructionError(0, InvalidAccountData)` on the close | the official sell already appends its own `CloseAccount` on the wrapped-SOL side |
| a 41% round-trip loss | measured before that unwrap; the proceeds were one account over, still wrapped |

## 7. Proof that the sell uses buy-mutated state

Measured, not argued. For each completed trip the base vault's `dataSha256` is
compared pre- and post-buy, and the same atoms are quoted against both states:

```
buyMutatedSellPool    true on every completed trip
self-impact           -3 to -19 bps
```

**The sign is the finding and the naive expectation is backwards.** A buy leaves
the pool with less base and more quote, so selling the same atoms back fetches
*more*. A fresh-state sell under-reports here rather than flattering. Taking a
magnitude would have hidden the direction.

## 8. Round-trip results

```
attempted                     70
complete lifecycles            3
TRUE_SEQUENTIAL_ROUND_TRIP     3
```

Most candidates fail at `MARKET_NO_CANONICAL_POOL` — they never migrated off the
bonding curve. That is a fact about the market, not the apparatus.

At 0.02 SOL: AMM drag 246 bps, stable across runs; the sell's realised proceeds
equal the offline quote to within the 5,000-lamport base fee.

## 9. Dimensionless mechanics — the size surface

`artifacts/true-stateful-size-surface.json`, `docs/TRUE_STATEFUL_SIZE_SURFACE.md`.

| notional | AMM drag | repeat-trade drag | position/reserve | latency |
|---|---|---|---|---|
| 0.001 SOL | 241.5 bps | 791.5 bps | 0 bps | 0 bps |
| 0.0025 | 241.5 | 461.5 | 0 | −0.5 |
| 0.005 | 241.5 | 351.5 | 0.5 | −1 |
| 0.01 | 241.5 | **296.5** | 1 | −2.5 |
| 0.02 | 241.5 | 269 | 2.5 | −5.5 |
| 0.04 | 241.5 | 255 | 5.5 | −11 |

The AMM drag is **flat** — at these sizes it is fee, not impact. What falls with
size is fixed cost amortising; what rises is price impact and latency exposure.

Every point reconciles to **1 lamport** against its named components, and the
residual is a reported field rather than something folded into the trade's
economics.

**Development notional: 0.01 SOL**, chosen prospectively as the smallest grid
size clearing a 300 bps mechanics gate. No return was looked at; the grid and
the gate were fixed before the first point.

## 10. Settlement, ledger and rent

`execution_cost_lamports` held `entryCashOut().cashOut` — principal plus costs.
The first effect-verified production buy reported 24,087,331 lamports of
"execution cost" against 4,087,331 of actual cost, the difference being exactly
the 20,000,000 principal. A 2× cost stress then doubled the principal.

`transferFeeLamports` used `?? 0n`, turning "not measured" into "none". Zero is
now returned only when the asset **cannot** carry a fee.

`rentExemptLamports` derives the exemption from the chain's own constants —
`(128 + len) × 3480 × 2` — instead of assuming 2,039,280, so a Token-2022
account with extensions gets its own larger figure. Only the exemption is
credited back on a created account; the coin-creator fee vault is opened *and
paid* in the same transaction and the excess is reported separately.

ATA recovery is measured per lifecycle: `entryAtaRentRecovered` is read from
whether the close actually returned it, not assumed.

## 11. Parity matrix

`artifacts/pumpswap-parity-v2.json`, `docs/PUMP_PUMPSWAP_PARITY_V2.md`.

```
mints                     3
cells                    36     (6 sizes x 2 sides x 3 mints)
exact runtime/offline    36 / 36
```

**Zero basis points on both sides at every size.**

The defect a one-size matrix could not have caught: before the fix the sell arm
disagreed by 41,818 bps at 0.001 SOL and 1,045 bps at 0.04 — six numbers, one
constant four-million-lamport error, only the denominator moving.

Coverage still absent, stated rather than implied: USDC quote, legacy SPL base,
bonding curve, Mayhem vs non-Mayhem, fee-tier boundaries, and parity against a
*landed* mainnet transaction.

## 12. Direct mint facts — NOW COLLECTED IN PAPER

The read was gated on `capitalAtRisk(mode)`. Paper risks nothing and produces
the entire research corpus, so **no row anywhere recorded** whether a candidate
carried a freeze authority, a transfer hook or a permanent delegate. The gate
that would refuse one in a capital mode had never fired on any token, ever. Its
false-positive rate, its cost in missed winners and its protective value were
all unmeasured, and the first run with money on it would have been the first run
at all.

The mode still decides what a hostile fact *does*. It no longer decides whether
the fact is looked at.

`solana/src/token2022.ts` is deleted. It graded the TLV area; `solana/src/mint.ts`
does that and also decodes both transfer-fee schedules, selects between them by
epoch, reports the worst case when the epoch is unknown, and refuses an
extension newer than itself. The directive's required-capability list is exactly
the second one's, and the pipeline called the first.

Live corpus after the restart: 73 mints, 69 Token-2022, 3 legacy, 1 unreadable
and recorded as UNKNOWN rather than dropped.

## 13. Four cohorts, exploration, strategy version

Three of four arms could not produce a single screening: the global 2m–60m age
gate was applied to every cohort, so a token that matured into `AGE_1H_5H` was
vetoed `too_old` by a window that only ever described `AGE_2M_60M`.

`floor(maxQuotesPerCycle × 0.25)` is 0 whenever the budget is under four, and
the configured budget is 2 — the stated 25% exploration arm had **never run a
quote**. The entitlement now carries across cycles.

The exploited arm's inclusion probability was 1. Reweighting on a 1 treats a
selected survivor as representing only itself, which is the bias the exploration
arm exists to measure. It is now `budget / eligible`.

The score computed v0.5 semantics while all four config files stamped rows
`delayed-momentum-v0.4.0`. Both are now `v0.6.0` and a test fails if they
diverge.

## 14. WSS alarms and the urgent queue

The reserve account was "the first writable account that is not the taker's and
not an ATA" — a position in a list, not an identity. It now watches the
canonical PumpSwap pool through the SDK's own PDA. `unwatch` passed an empty
string, so every closed position leaked its subscription. And `urgentMarks` was
written by the alarm callback and read by **nothing**.

## 15. Direct event pipeline

`artifacts/direct-signal-status.json`.

```
received/s   1,098        parsed 16.6%
dropped      0            queue high water 3,251 of 5,000
rows/day     1,309,738    against the firehose's 91,155,852
compression  20.3 trades per bar
```

The drain ran **synchronously inside** `offer()`, so the queue never held more
than one event and `maxQueue` was unreachable. `feedsProductionDecisions: false`
is stated in the artifact. It is telemetry.

## 16. Confirmatory view and readiness

One position could produce **nine** rows: v1 and v2 JOIN `simulation_jobs` on
the observation id, and the live corpus has observations with three jobs. v3
uses `EXISTS`. Measured in test: v2 emits 9, v3 emits 1.

Drawdown started at **zero cumulative PnL**. The first losing trade has
`peak = 0` so the branch is skipped entirely, and a 0.01 SOL give-back against
0.02 SOL of profit reads as a 50% drawdown. Both errors point the same way early
in a sample. Equity now starts at the frozen starting NAV.

Every artifact carries its commit, dirty flag, strategy version, schema version
and sample query, and freshness **refuses** rather than warns.

## 17. Reject panel

`artifacts/reject-panel.json`, `docs/REJECT_PANEL_V2.md`. 68 mints, 24 strata,
seeded and versioned, inverse-probability weighted.

```
NO_ROUTE_CONFIRMED       55
EXECUTABLE_VALUE          9
UNBUILDABLE               3
SIMULATION_UNAVAILABLE    1
```

**Twenty of twenty-four gates are refusing tokens the direct family could not
have traded anyway** — no canonical pool. Their measured cost in foregone
entries is approximately zero, and so is their measured benefit.

`excessive_impact` and `insufficient_flow` are the two that bite: every sampled
reject under `excessive_impact` had a pool and filled in the runtime.

Caveat stated in the artifact: `NO_ROUTE_CONFIRMED` means no *canonical PumpSwap
pool*, not that no venue exists anywhere.

## 18. Infrastructure decision — NOT JUSTIFIED

`artifacts/rate-budget.json`.

```
measured bottleneck   mark_scheduler_below_rate_ceiling
call rate             0.30/s against a 1 RPS ceiling
Developer plan        NOT JUSTIFIED
```

The binding test previously read `rateLimited > 0 || backlog > 0`, so a backlog
alone made the upgrade come out **JUSTIFIED** on a window whose call rate was a
third of the ceiling. It would have recommended paying to raise a bound that was
never reached. A backlog is evidence only while the call rate is near the
ceiling; below it, the bottleneck is the scheduler and no plan buys that.

Nothing else is purchased. The artifact says no to archival RPC, premium gRPC,
shreds, colocation, a large VPS and a dedicated validator by name.

## 18b. Required tests

`tests/unit/p24-required-3bc708d.test.ts` is the index, and it is **asserted**:
every named home must exist and contain tests, the uncovered items must be
exactly the ones named with reasons, and the count is checked.

```
48 of 48 covered
```

`NOT_COVERED` is empty. Item 32 was in it, on my claim that Mayhem had no
verifiable source; that claim was wrong and the item is now covered by
`tests/unit/mayhem-p11.test.ts`.

The index found two of its own errors on first run: two homes it named did not
exist. Both were then written.

Suite: **84 files, 1,157 tests, 4 skipped.**

## 19b. Production core and call graph (P5) — DONE

`scripts/call-graph.ts`, `artifacts/production-call-graph.json`, `pnpm callgraph`.

Machine-generated and resolved through the TypeScript **checker**, not by
matching text: `db.prepare(...)` and a local `prepare` are different things, and
a graph that conflated them would report edges nobody wrote. It exits non-zero
on a missing edge, so CI fails on a lifecycle that has been quietly unhooked.

All 15 required edges hold, and **0 of 8 lifecycle functions are declared in the
process shell** — admission and mark selection live in `paper-core.ts`,
settlement in `domain/settlement.ts`.

The reason this exists rather than a source-substring test: this system has
twice shipped a decision path nothing called — the urgent-mark queue that ended
in a `Set.add`, the exploration arm allocated a budget of zero. Both would have
passed a grep for a reassuring identifier, because the identifier was there.

## 19c. Shadow trajectories (P6) — DONE, and it voided the shadow corpus

The call graph found it on its first run:

```
MISS manageShadowBooks -> admitPortfolioExit
```

The shadow loop ran `decideExit` on a mark and closed on **that same mark, at
that same mark's value**. That books a fill at the price which *caused* the
decision to exit, observed before the decision existed — the one price a real
exit can never get, and one that flatters in both directions: a stop fires on a
drop and fills at the drop, a take-profit fires on a spike and fills at the
spike.

`packages/domain/src/shadow-lifecycle.ts` has forbidden that transition since it
was written, and its guard says so in words. **No production file imported it.**

**All 1,038 closed shadow positions are void**, and so is the −18,338,967,174
lamports summed across them. `docs/SHADOW_TRIGGER_FILL_INVALIDATION.md`.
`fill_latency_ms IS NULL` marks a pre-P6 row.

The loop now runs on the machine, and a fill must be strictly later than the
trigger, past the frozen 1,200 ms latency, same route family, effect-valid on
its own, and priced. The **first** such observation is the fill — choosing among
later observations after seeing them all is look-ahead under another name.
`EXIT_BLOCKED` is not terminal.

Live after the restart: **40 positions `AWAITING_FILL_OBSERVATION`**, where
before every one of them would have closed.

## 19d. Entity links (P11) — DONE; Mayhem still has no source

`intelligence/entity.ts` clustered holders by union-find over a list of links,
and **no production caller ever produced a link**. `cluster()` was always called
with an empty list, every holder was its own entity, and the entity-adjusted
concentration equalled the address concentration exactly — a number that looked
like a second opinion and was the first one restated. Third dead module this
session.

`entity-links.ts` builds `COMMON_FUNDER` from real history: the funder is the
fee payer of a holder's first transaction. The other link kinds the directive
lists need full transaction bodies per holder and are left unbuilt rather than
approximated.

**The generic-funder guard was wrong on the first attempt and its own test
caught it.** I had suppressed any funder behind a large share of one mint's top
holders, reasoning about exchange hot wallets. That is backwards: an exchange
funds people who then buy many different tokens, so it sits behind a small
fraction of any one token's holders, while a funder behind sixty per cent of a
memecoin's top wallets is precisely the sniper cluster the measurement exists to
find. Genericness is a cross-mint property and the caller now supplies it.

**Mayhem: I was wrong that it had no source.** I recorded the requirement as
unsourceable and left the table empty. `isMayhemMode` is a decoded field on the
PumpSwap **pool** account — in the same IDL this system already uses to price
every swap — and `is_mayhem_mode` is a field on the pump **bonding curve**,
which covers the pre-migration half of a token's life. The pool bytes were
already being captured. I found it only because the question was asked again and
I checked the IDL instead of repeating the claim.

What is genuinely unavailable is the Mayhem *program's* account layout;
`MAyhSm…` publishes no IDL. Agent identity, inventory, buys, sells, additional
supply and the burn transition stay null with the reason attached rather than
being read out of guessed offsets — a guessed inventory is worse than an absent
one, because it would be subtracted from organic flow with confidence.

The grading follows honestly: a Mayhem venue's breadth is **unusable, not
adjustable**. There is deliberately no function returning an "organic volume"
number, because subtracting an unmeasured quantity is a guess with a minus sign.
An unread venue is not organic either.

## 19e. Tournament (P19) — PREREGISTERED AND ALLOCATED, NOT RUN

`packages/domain/src/tournament.ts`, `docs/DEVELOPMENT_TOURNAMENT.md`.

Three entry arms × two exit arms, no parameter grid. Checkpoints at 10 / 25 /
50 / 100 completed trajectories per arm. Seven elimination reasons, each a pure
function of a preregistered observation. `MECHANICS_DRAG_CONSUMES_EDGE` is
judged against the size surface's own 241.5 bps.

Allocation is balanced, deterministic, and **blind to the candidate** —
`allocateArm` takes one argument, so there is nowhere to pass a score.

**It does not run.** Zero valid trajectories exist; the first checkpoint is ten
per arm; at three per day per arm across six arms that is ~17 days, with the
mark-scheduler backlog an open blocker. What is wired is the allocation, so
arriving trajectories are already assigned rather than labelled afterwards.

## 19f. The mechanics floor is not a constant (P14, offline)

`artifacts/fee-tier-surface.json`, `pnpm fee:tier-surface`.

The size surface measured 241.5 bps of AMM drag, **flat across every size in its
grid**. That is correct and easy to misread. PumpSwap's fee is a table keyed on
the pool's **market cap**, decoded from fee-config bytes already sitting in the
round-trip fixture:

```
25 tiers       round trip 250 bps at the bottom -> 60 bps at the top
               a 190 bps spread
24 boundaries  the parity matrix straddled NONE of them
```

Every mint in the size surface sat in the **bottom tier — the most expensive
one**. The drag is flat in *size* and a step function across *tokens*, so
241.5 bps is a floor for small-cap tokens, not a constant of the venue. A pool
above ~44,000 SOL pays roughly a quarter of it.

That matters for something written earlier the same day:
`DEVELOPMENT_TOURNAMENT.md` said `MECHANICS_DRAG_CONSUMES_EDGE` is judged
against "the size surface's own number — 241.5 bps". An arm trading larger-cap
tokens would have been eliminated for a cost it does not pay. `judgeArm` already
takes `mechanicsDragBps` per arm, so the code was right and the doc was wrong;
both now say the floor must come from the tiers of the mints an arm traded.

## 19g. What the mint corpus says (P11 read back, offline)

`artifacts/mint-facts-status.json`, `pnpm mint:facts-status`.

The first read-back of what P11 collected, and it answers a P14 coverage
question without a single call:

```
22,748 mints read       21,869 Token-2022, 879 legacy SPL
hostile                 24 (0.11%)
  live freeze authority   18
  live mint authority     11
  transfer hook            3
  permanent delegate       1
transfer fees           90 mints — 89 at 300 bps, 1 at 500
unknown extensions       0
pending fee changes      0
provider disagreements   0
```

**Legacy SPL base is a sampling gap in the parity matrix, not a universe gap** —
the corpus holds 879 of them.

A 300 bps transfer fee is charged on both legs, so it is **600 bps per round
trip against a 241.5 bps baseline** — 3.5× the mechanics floor. I checked
whether that fee actually reaches the admission gate rather than assuming it: it
does. The entry path refuses outright when the fee is unmeasured, and
`immediateRoundTrip` is computed from measured settlements that carry it.

Zero provider disagreements is worth stating precisely: where Jupiter's audit
fields and the chain both had an answer, they agreed. That makes the provider
*reliable so far*, not authoritative.

## 19h2. Entity concentration at scale (P11)

`artifacts/` rows in `entity_concentration`, `pnpm enrichment:probe`.

**The history was read from the wrong account.** `buildEntityLinks` asked for the
OWNER wallet's oldest signature. `getSignaturesForAddress` returns newest-first,
so the "oldest" of a bounded page is the *N*th-newest transaction of an active
wallet, not its first — and its fee payer is usually the wallet itself, which
links nobody. Every reading came back with zero links and an honest
`trustworthy: false`, which is exactly why it looked like the module ran and
found nothing.

Clustering still happens over the **owner**, because that is the actor who can
sell. History now comes from the **token account**, which was created for this
mint, has a handful of transactions, and whose first one is its creation — whose
fee payer is the funder being looked for.

With that fixed, 42 mints and 111 links, and the pattern is consistent:

| | by address | by entity |
|---|---|---|
| holders | 20 | 13 |
| top-10 share | 5,242 bps | **8,574 bps** |

Roughly **+3,000 bps** on the worst cases. A token that looks 53% concentrated
by address is 86% concentrated by actor — which is the whole reason the
entity-versus-address comparison exists.

`trustworthy` is still **false everywhere**. With seven links out of twenty
holders, too many histories remain unread for the entity figure to be a better
number than the address one, and it says so rather than presenting itself as
authoritative.

## 19h. Parity against landed transactions (P14)

`artifacts/landed-parity.json`, `pnpm pumpswap:landed-parity`.

Every other parity arm compares the model to something this system produced —
another decode, or the local runtime. They can all agree and all be wrong in the
same way. This one compares against what the chain recorded.

No archival node needed: a landed transaction carries `meta.preTokenBalances`,
so the pool vaults' contents *before* the swap travel with the transaction.

**Two corrections, both to the comparison rather than the model:**

The first pass compared against the **pool vault** delta and found a residual of
exactly **−123 bps**. That is not a model error — it is the protocol and creator
fee, 93 + 30 bps at the bottom tier, leaving the vault for accounts that are not
the taker. The vault moves by the taker's proceeds *plus* those fees. Switching
to the taker delta gave three exact matches out of four.

The second pass, on a wider sample, scattered — and its median of 0 bps was an
artefact of the spread, not a result. Two causes, both attribution: a routed
transaction moves the fee payer's balance for several legs at once, and a buy
funds its wrapped-SOL account with a slippage-padded `maxQuoteIn` that returns on
close, so neither the account delta nor the native delta is what the swap
consumed.

The headline therefore counts only **direct single-hop swaps whose taker-side
quantity can be isolated**. Routed cases, and cases whose residual exceeds what
the fee table can explain, are kept in the artifact with their numbers and
excluded from the summary.

On a working endpoint, over 200 transactions examined:

```
direct, isolatable   21     (4 buys, 17 sells)
EXACT (0 bps)        12
median residual       0 bps
routed               52     excluded
attribution uncertain 34     excluded
```

The non-zero direct residuals run 1 to 239 bps and are **not yet explained**.

## 19i. RPC capacity

`pnpm rpc:capacity`. Prints hosts and verdicts, never URLs: the configured
endpoints carry API keys in their query strings.

```
primary   mainnet.helius-rpc.com        CAPPED (plan quota exhausted)
fallback  (not configured)
public    api.mainnet-beta.solana.com   OK
```

The keyless public endpoint serves `getAccountInfo`, `getTokenSupply`,
`getSignaturesForAddress` and `getTransaction`, and throttles
`getTokenLargestAccounts` away. So the Mayhem read and landed parity are
unblocked; the entity read is not, because the holder set is exactly what
`getTokenLargestAccounts` provides.

`RPC_ENDPOINT` is an **explicit override, never a silent fallback**, and is
stamped into every row it produces. A silent fallback would put rows from two
sources in one table with nothing to tell them apart.

## 20. Not done, and why

- **The live write through the CYCLE.** `mayhem_facts` (48 rows) and
  `entity_concentration` (42 rows) are populated by `pnpm enrichment:probe`; the
  in-cycle path runs only for candidates reaching the quote stage, and
  eligibility is ~0.25%, so it will fill slowly on its own.
- **The Mayhem program's own account layout.** No IDL is published, so agent
  inventory, buys, sells and the burn transition are refused rather than
  guessed.
- **P19 execution.** Preregistered and allocated (§19e); it cannot run without
  trajectories.
- **P22** confirmatory window. Gated on an arm being selected by P19.
- **P14** remaining matrix cells (§11): USDC quote, legacy SPL base, bonding
  curve, Mayhem vs non-Mayhem. §19g establishes that legacy SPL base is a
  **sampling** gap rather than a universe gap. Landed-transaction parity is now
  done (§19h) on a small sample.
- **A trustworthy entity reading.** 111 links exist and no mint yet has enough
  holder histories read for `concentration()` to call its entity figure
  trustworthy. That is a coverage problem, not a correctness one.
- **Wiring the three stronger entity link kinds.** `SHARED_FEE_PAYER`,
  `SAME_TRANSACTION` and `DIRECT_TRANSFER` are implemented and tested
  (`buildTransactionLinks`), behind a separate `TransactionSource` so a caller
  with a small budget can decline them and get a smaller claim rather than a
  wrong one. No production caller supplies that source yet — it needs full
  transaction bodies per holder, and the RPC cap is exhausted.
- **A parity cell that straddles a fee-tier boundary** (§19f). The boundaries
  are now enumerated; sampling across one needs the network.

## 21. Commands

```bash
pnpm paper
```

```bash
pnpm simulator:true-stateful-proof
```

```bash
pnpm size:true-stateful-surface
```

```bash
pnpm pumpswap:parity-v2
```

```bash
pnpm reject:panel
```

```bash
pnpm rate:budget
```

```bash
pnpm callgraph
```

## 22. Every unresolved blocker

1. **Production still cannot open a position** at the current risk budget
   against the measured mechanics floor. The lifecycle machinery is proven in
   the runtime; the paper engine has not produced a complete trajectory through
   it.
2. **The sample is small and possibly selected.** Three mints in the parity
   matrix, four in the size surface, three complete round trips. Two of six
   mints attempted failed entirely in the runtime, so the sample is "the mints
   the apparatus can simulate".
3. **No sell parity against a landed mainnet transaction.** Parity is against
   the runtime, which is the same model the quote came from in one of the four
   arms.
4. **The mark scheduler is behind at a third of the rate ceiling** and the cause
   is unidentified.
5. **Dust cannot be exited.** One atom of these tokens prices at zero lamports.
6. **P5, P6, P19 and P22** as above.

## 23. Final state

```
MEASUREMENT_REPAIR_REQUIRED
```

Not `VALID_STATEFUL_TRAJECTORIES_RUNNING`. That requires

```
the running paper engine
→ true sequential state
→ complete settlement
→ identical ledger
→ later fill
→ balanced cohort trajectory
→ clean current context
```

The sequential runtime produces complete, correctly classified buy→sell→close
lifecycles with economics that reconcile to one lamport. The shadow lifecycle
now triggers and awaits a later fill, and 40 positions are in that state right
now. Tournament arms are allocated as trajectories open.

**No trajectory has completed through the repaired lifecycle**, the paper engine
does not drive the sequential runtime, and every one of the 1,038 shadow results
that existed before this directive is void. The measurement apparatus is
repaired; the generator that would use it has produced nothing yet.

Not `DEVELOPMENT_ARM_SELECTED` either. P5 and P6 now pass, so P19 is no longer
blocked by them — it is blocked by having zero completed trajectories against a
first checkpoint of ten per arm.
