# Final report — 02483ca max-profitability directive

## 1. SHAs

| | |
|---|---|
| starting (audited master) | `02483ca45b2c40a98637f88c01d8bbef5e1c5496` |
| ending | `a5747a7` |
| commits | `08ce787` baseline · `a725afc` P2–P4 · `03e4539` measurement repair · `2a68706` one leg spec · `62056c9` stateful round trips · `5c35984` core/PnL/episodes · `77a06d7` score arithmetic · `16e9fea` risk alarm · `56356a2` cohorts + exploration · `67e6692` admission surface · `5547f31` preregistration · `7604024` trigger≠fill · `b7dae95` confirmatory v2 · `e8c687a` migration split · `75cd524` capitalAtRisk · `7ce50ea` >2^53 · `9840618` direct clock |

## 2. Local differences from committed head

Local was **identical** to `02483ca` at session start (verified by
`git rev-parse`, and `merge-base --is-ancestor`). Nothing local was newer and
nothing was discarded. The WSL simulator clone at `/home/lyman/epitaxy` was
also at `02483ca` and has been fast-forwarded to `2a68706` and restarted.

## 3. Backup

```
sha256     7059d80418cd1228d32afcebf3489f83f6190adcb5c62f50dc38dd976a060704
integrity  ok
fk         0 violations
witness    execution_observations 30,912 rows, within [30,912, 30,912]
```

## 4. Current exposure

**None.** 20 portfolio positions, all closed and all older than 24 hours; zero
hold tokens. 163 open shadow positions, which bear no capital. Paper mode
cannot transact — it does not import `packages/execution/`.

## 5. Invalidated contexts

`docs/02483CA_WINDOW_INVALIDATION.md`. Everything through this repair is
instrument/development-only. Rows preserved; no threshold, weight, exit rule or
cohort selection fitted to them.

## 6. Production/proof request unification — DONE

`packages/simulator/src/leg.ts` defines `EconomicLegSpec` and
`buildSimulationRequestForLeg()`. It is the only request constructor, used by
the proof harness, `simulate-observation.ts`, and the tests. The interim
builder was deleted; `mint + minTokenDelta` has no writer left, only readers for
pre-P2 rows. `simulationValidity()` now validates the economic leg.

**The root cause of production's zero effect-verified legs**, found by making
the two paths share one builder:

> No production caller ever passed `outputTokenProgram`.

A buy could not name the asset it received, so its credit had no account to
bind to and the run verified nothing about the money — while still able to
report `SIMULATED_OK`. Production has produced **4 effect-verified legs** since,
against 0 in the entire prior corpus of 136 jobs.

Protocol bumped 4 → 5: the request now binds the capability fingerprint, so one
hash cannot span two different pool paths.

## 7. Above 2^53 — INSTRUMENT PROVEN, MARKET CANNOT REACH IT

The daemon precheck ran `exactNumber` over **every** balance mutation, refusing
token amounts above `MAX_SAFE_INTEGER` before reaching the exact-byte path that
has no such limit. SOL still crosses the boundary and is exact-range checked;
token atoms are u64-range checked and written as bytes.

Proven against the live daemon: 10^18 atoms reach raw account bytes;
2^64 is refused as not a balance the chain can hold.

`artifacts/big-atoms-proof.json`, `docs/BIG_ATOMS_P3.md`.

**No live BUILD_CUSTOM route in this corpus can credit more than 2^53 atoms at
any notional**, and this is measured rather than assumed. Output is sublinear
in input — the credit is bounded by the pool's token reserve, not by what is
spent:

| hypothetical buy | measured credit |
|---|---|
| 20 SOL | 511,331,707,065,605 |
| 600 SOL | 951,494,455,050,882 |

Thirty times the input for 1.86× the output. The best live route asymptotes
near 9.5 × 10¹⁴, which is 10.6% of 2^53. The gap is the tokens currently
reachable, not the encoder, the request hash, the daemon precheck or the
settlement. The check remains in place and runs against whatever is live.

## 8. Effect and conservation

The residual is now DERIVED, not read from a column:

```
residual = payer native delta
         - (credit - tradeDebit - fees - tip - rentCreated + rentRecovered)
```

Measured **0** on both legs of the first production round trip.
`unexpected_movement_lamports` was being read as this and is a different
quantity — value reaching accounts the request did not name, which on a working
swap is the pool vaults and the new token account. It measured 24,078,560 on a
leg whose true residual was zero, and it was refusing every leg that worked.

## 9. Stateful round-trip cases

`artifacts/stateful-roundtrip-proof.json`, `docs/STATEFUL_ROUNDTRIP_PROOF.md`.

```
attempted   25      complete             5
instrument   0      unknown-cost        20
market       3      ATA created+closed   5
```

**The finding — a mechanical cliff at ~10^9 acquired atoms:**

| acquired atoms | trading loss | n |
|---|---|---|
| 168 – 44,590,556 | ~10,000 bps | 17 |
| 5.49e9 – 8.63e11 | 66 – 335 bps | 8 |

Nothing between 4.46e7 and 5.49e9; no exceptions in 25 samples. Below it the
sell returns 3–5 lamports on a 20,000,000 lamport buy. Quantization, not price.

A hypothesis this falsified: the first six cases were all Token-2022 and all
lost ~99.9%. Widening the sample put Token-2022 mints at 205–271 bps and legacy
mints at 10,003. The discriminator is atom count, not token program.

## 10. ATA rent recovery

`packages/solana/src/closeaccount.ts` builds `CloseAccount`, appended to the
exit rather than sent separately. All five complete lifecycles created and
closed the account. Rent is treated as **locked capital**: `tradingLossBps`
excludes it from both sides of the ratio and is what the cap gates on;
`lossBps` keeps the all-in figure and is reported. Measured on the first
production round trip: 3,688 bps all-in against **363 bps** of trading cost.

## 11. Failure costs — DONE

The runtime charged `assumedFailedAttemptLamports` at probability 1 on every
entry and exit that **succeeded**. That is not an expected-failure model: it
fabricates one failure per success and charges it against realised PnL.
Realised legs now charge zero when no failure occurred.

`transferFeeLamports: 0n` is gone from the realised path — it reads the measured
settlement, and an unobserved fee is refused rather than charged as zero.

## 12–14. Size surface, effective score, mechanics gate — DONE

`artifacts/economic-admission-surface.json`, `docs/STATEFUL_SIZE_SURFACE.md`.

Machine-generated through the same `sizePosition` and `viableFloorLamports` the
engine uses:

```
NAV                    9.582071288 SOL
risk budget per trade  0.023955178 SOL   (0.25% of NAV)
round-trip overhead    0.00206528  SOL
min viable notional    0.0209128   SOL
configured min score   0.35
EFFECTIVE min score    0.88
```

**`minOpportunityScore = 0.35` has never rejected anything sizing would have
admitted.** A score of 0.87 sizes to 0.020841 SOL and is refused by 71,796
lamports; 0.88 is the first admitted size.

This is why no position has opened — not the gates and not the score. 0.25% of
a 9.58 SOL book is 0.024 SOL, and fixed costs need 0.021 SOL of notional before
they stop dominating. The honest lever is the overhead (P6's ATA close removes
its largest term), not NAV or the risk fraction.

The preregistered six-point notional grid was **not** run: at 0.02 SOL the round
trip is already quantization-dominated for two thirds of live candidates, and
every smaller size makes that worse rather than revealing a different regime.

The mechanics gate **is** live: production entry computes the immediate round
trip from two measured settlements and refuses above `maxRoundTripLossBps`
(400). It refuses all 17 cliff cases and admits the 54–109 bps ones. Previously
the number was computed correctly and recorded at `info` — the gate existed, the
measurement existed, and nothing connected them.

## 15. Production core call graph — DONE

`paper.ts` calls `admitPortfolioEntry`. The observe → simulate → measure →
observe exit → simulate → measure → gate sequence lived in both files and only
the `paper.ts` copy ran; the duplicate is gone.

The core decides but does not query: measured credit and measured round trip
arrive through injected readers, so it refuses on the same settlements the
engine books from. Its old contract took `tokensFrom(buy)`, which read the
router's floor off the observation — what the buy promised not to go below,
not what it delivered.

## 16. Explicit PnL fields — WRITERS DONE, NO ROWS

Migration 25 adds `entry_cash_out_lamports`, `exit_cash_in_lamports`,
`locked_rent_lamports` and `residual_token_atoms`. Production writes all of
them plus the three from migration 22, from the measured settlement, and the
identity

```
net_pnl_lamports = exit_cash_in_lamports - entry_cash_out_lamports
```

holds on the row with both operands written in the same statement, so a reader
can check it rather than trust it. Rent is identified separately rather than
netted into either side.

**Zero rows carry them**, because no position has opened — see §12–14 for why.

## 16b. Signal episodes (P11) — DONE

The episode identity was `floor(now / 15 minutes)`. Two screenings at 14:59 and
15:01 are two minutes apart, landed in different buckets, and became two
episodes — so the second opened a second position on the same signal. Two at
14:01 and 14:59 are fifty-eight minutes apart, shared a bucket, and the second
was refused as a duplicate. The boundary did the opposite of its purpose in
both directions, depending on where a signal fell against a clock it has no
relationship to.

An episode is now durable state, closed when the book flattens.

## 16c. Score arithmetic (P18) — DONE

Four defects, each wrong independent of any outcome. A provider `organicScore`
of 0 is *not computed* — the gate already treated it that way while the score
charged the same 0 at full weight, so one absence was penalised twice, hardest
on the young tokens the strategy is defined over. Breadth kept its full weight
with one subfeature missing. Unknown tradability and unknown age returned 0,
the maximum penalty, for a measurement we had not made. Coverage is now
reported rather than folded in.

Two existing tests asserted the double penalty with `toBeGreaterThan` and now
assert equality. Strategy version → `delayed-momentum-v0.5.0`. Ledger entries
MT031–MT034.

## 16d. Risk alarm (P15) — DONE

Five defects, all silent. Nothing constructed `ReserveAlarm`; `connect()` was
never called; `unwatch()` deleted a map entry while its caller's comment claimed
it sent a real unsubscribe; reconnect was registered on both `error` and
`close`, so one failure scheduled two reconnects and the count doubled per
cycle; and a subscription nobody acknowledged counted as coverage.

The engine now constructs it, starts it, registers each position's pool reserve
at entry and releases it at close. Raw socket state remains an alarm and never
becomes a mark or a fill.

## 16e. Cohorts and exploration (P16, P17) — DONE

Only `AGE_2M_60M` ever matured: `maturingMints` took one window from
`config.gates`, so three arms were defined, bounded, assigned to rows, and never
received a candidate. All four now mature with their own quota.

25% of the quote budget goes to a stratified random draw from candidates the
ranking did **not** take, with `selection_arm`, `inclusion_probability` and
`selection_stratum` on every row. A gate evaluated only on the candidates it
admitted is evaluated on its own output. The draw is seeded rather than
`Math.random()`, so a cycle replays.

## 17. Trigger → later fill (P10) — DONE

`fill-latency.ts` held `resolveFill` and `FROZEN_FILL_LATENCY_MS` and had
**zero production callers**. The engine observed a route, decided to exit, and
closed against that same observation — a fill at the instant of noticing, with
no reaction, build, simulation, signature or landing in between. Every exit in
the corpus was priced at a moment no real exit could reach, and the bias is
systematically favourable because a policy fires when the price is most extreme.

The trigger is persisted and the position moves to
`AWAITING_FILL_OBSERVATION`, which is in `MANAGED_STATES` because it still
holds the tokens. The fill must be a later same-family effect-verified priced
observation, at least 1,200 ms after the trigger, and `resolveFill` takes the
**first** valid one rather than the best — taking the best would be choosing
the fill after seeing the outcomes.

## 18. Readiness and the canonical view (P21) — DONE

`confirmatory_positions_v2`. v1 is kept unchanged, because a view edited in
place rewrites history. v2 additionally requires the explicit cash-flow fields,
the identity `net = cash_in − cash_out` **recomputed in the view**, a residual
that is present and zero, a trigger with a fill latency ≥ 1,200 ms, a durable
manifest and `REPLAYABLE` on both legs, and a frozen strategy version and
cohort. Readiness reads v2.

A schema defect this caught: the P10 and P17 statements were appended to
migration 25 **after 25 had already run**, so they never executed — the schema
believed it was current while the columns did not exist. Split into migration
26 and verified against the live database (`schema-v26`).

## 19. Direct Pump/PumpSwap event clock (P12) — DONE

`logsSubscribe` on both programs at `processed`, one subscription each rather
than a global firehose. Events land in `direct_chain_events` with slot,
commitment, monotonic receipt time and the transaction error — commitment
because `processed` can be reverted, and a row that does not say which
commitment it arrived at cannot be reconciled.

**The reason nothing websocket-based had ever run**: `rpcHttp` fell back to the
Helius key and `rpcWs` did not. An operator with a key configured got HTTP and
no websocket, so the reserve alarm and the direct clock were both constructed,
both logged an absence at `warn`, and neither connected. Two transports of one
endpoint, one derived and one not.

Measured in roughly thirty seconds of one live socket after the fix:

```
72,273 events    max slot 439,133,929
 8,943 TRADE     13,666 OTHER     49,616 UNKNOWN
```

## 20. Token-2022, capitalAtRisk and entities (P14) — PARTIAL

`capitalAtRisk` has one definition and reaches the gates. `screenCheap` never
passed it, so every cheap gate ran with `false` even in canary and live: the
strictness that exists for the modes that spend money was unreachable from the
path those modes use. `evaluateCheapGates` has read an optional `token2022`
input since it was written and no caller ever supplied it, so
`token2022_money_critical` could not fire — a transfer hook, a permanent
delegate, a pausable mint and a default-frozen mint all presented as silence.

In capital modes the pipeline now decodes the mint and passes the facts, and an
**unread** Token-2022 mint is refused rather than passed as unknown.

**Not done:** Mayhem lifecycle fields and entity linking (common funder, shared
fee payer, bundle co-occurrence) do not reach `runCycle`.

## 21. Official PumpSwap parity (P13) — DONE, EXACT

`artifacts/pumpswap-parity.json`, `docs/PUMP_PUMPSWAP_CURRENT_PARITY.md`.

Both SDKs installed at the pinned versions the directive names. **5 of 5
measured pools matched to the atom — median and worst residual 0 bps**, against
a bar that says 123-257 bps is not parity.

The local side is the SDK's own `buyQuoteInput` over its own decoders, not a
reimplementation. That is why it is exact: the fee tier is dynamic and the
quote reserve is effective (`raw vault + virtualQuoteReserves`), and neither
survives being written from memory.

Still missing: the bonding-curve V2 side, parity against a settled on-chain
swap, and a per-fingerprint allowlist. 35 of 40 candidates had no canonical
pool because they have not migrated — so the youngest cohort, which is the one
this strategy is defined over, cannot be priced by this model at all.

## 22. Offline Rust/LiteSVM worker (P20) — BUILT AND RUNNING

`offline-worker/`. cargo 1.97.1, litesvm 0.6.1, vendored OpenSSL, an 18 MB
release binary. Immutable job file in, immutable result file out, one process
per job, no network. Every result carries the runtime identity and the binary's
own sha256, because there is no global parity boolean.

It restores accounts with the executable flag set — which Surfpool's
`setAccount` could not, so a program restored through it came back
NON-executable and every route through it failed with an error that looked like
a fact about the token.

Still missing: the 10-buy / 10-sell per-fingerprint comparison against the JIT
path.

## 23. What remains `docs/P13_P20_BLOCKERS.md` records exactly what
blocks each: the two SDK versions are verified as published (1.36.0 / 1.19.0,
matching the directive) but not installed, and there is no Rust toolchain on
Windows or in WSL. Neither is written from memory, because P13's own bar is
that a 123–257 bps residual is not parity, and a plausible-but-wrong local
quoter is wrong with authority.

P13 and P14 in particular require pinning and verifying external SDKs against
current official documentation and then proving parity to the lamport — that is
a session of its own, and a half-wired fact source that silently returns nulls
is the exact defect class this directive is about.

P19/P23 are preregistered in `docs/DEVELOPMENT_PREREGISTRATION.md`: four
cohorts, one control exit and one mechanism-distinct challenger, checkpoints at
10/25/50/100, and kill rules at 50 that do not protect the original thesis.

## 24. Valid development positions by arm

**Zero.** No arm has a valid stateful position.

## 25–27. Offline parity, fingerprints, throughput

Offline Pump replay remains blocked (`surfnet_writeProgram` drops its RPC on the
10.5 MB program; the `.so` path was ruled out). The Rust/LiteSVM worker is not
built. Capability fingerprints are now computed per observation and bound into
the request hash.

## 28. Jupiter upgrade decision

**Not yet.** The constraint on label production this session was correctness,
not rate. Three market failures out of 25 were provider responses without a
blockhash, not throttling. Revisit when the production generator runs and 1 RPS
is measured to reduce valid stateful labels per day.

## 29. Unresolved blockers

1. **No position can open at the current configuration.** The risk budget
   (0.024 SOL) barely clears the mechanics floor (0.021 SOL), so the effective
   score threshold is 0.88. This is now measured rather than suspected.
2. No live stateful buy→sell→close label from the running engine.
3. No live case above 2^53 atoms — and none is reachable; see §7.
4. Token-2022 transfer/withheld fees unmeasured — 20 of 25 lifecycles
   disqualified as unknown-cost.
5. `expectedRecipients` is empty everywhere, so the unexpected-recipient check
   cannot bind (P4 requires it mandatory).
6. Offline Pump replay blocked; no Rust/LiteSVM worker (P20).
7. Durable ordering state machine (P4) not implemented — a crash between
   runtime return and effect persistence still leaves an unrepairable cached job.
8. P12 direct Pump/PumpSwap event clock not built; the signal clock is still a
   30-second provider poll.
10. P13 official Pump/PumpSwap model and parity not implemented.
11. P14 Mayhem, Token-2022 mint facts and entity links do not reach `runCycle`.
12. P24 confirmatory window untouched, and P25 executor deliberately so — both
    are downstream of having any valid label.

## 30. Commands to keep collection running

```bash
pnpm paper
```

```bash
pnpm simulator:stateful-roundtrip-proof
```

```bash
pnpm settlement:check
```

The WSL daemon must be running first; it serves `127.0.0.1:8787` from
`/home/lyman/epitaxy`, which is a separate clone and must be fetched and
restarted after any change to `apps/simulatord` or `packages/simulator`.

## 31. Final state

```
MEASUREMENT_REPAIR_REQUIRED
```

The measurement was repaired in several important places — production and proof
now build one request, production produced its first effect-verified legs, the
residual identity holds at zero, rent is separated from trading cost, and the
first complete stateful lifecycles exist. But the bar for
`VALID_EFFECT_LABELS_RUNNING` is explicit: the **running paper engine**, not a
proof script, must have produced complete stateful buy→sell→close labels under
the repaired context. It has produced none. `paper.ts` still duplicates entry
instead of calling core, and no position has opened under the repaired code.
