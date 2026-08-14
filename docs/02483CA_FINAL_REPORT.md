# Final report — 02483ca max-profitability directive

## 1. SHAs

| | |
|---|---|
| starting (audited master) | `02483ca45b2c40a98637f88c01d8bbef5e1c5496` |
| ending | `62056c9` |
| commits | `08ce787` baseline · `a725afc` P2–P4 · `03e4539` measurement repair · `2a68706` one leg spec · `62056c9` stateful round trips |

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

## 7. Above 2^53 — PARTIAL

The daemon precheck ran `exactNumber` over **every** balance mutation, refusing
token amounts above `MAX_SAFE_INTEGER` before reaching the exact-byte path that
has no such limit. SOL still crosses the boundary and is exact-range checked;
token atoms are u64-range checked and written as bytes.

Proven against the live daemon: 10^18 atoms reach raw account bytes;
2^64 is refused as not a balance the chain can hold.

**Not yet done:** no live BUILD_CUSTOM proof case exceeded 2^53. The largest
observed was 8.63 × 10^11. At a 0.02 SOL notional no route produced one.

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

## 12–14. Size surface, effective score, mechanics gate

The size surface (P7) was **not** run — the cliff finding above supersedes its
premise at 0.02 SOL and the grid needs the production generator first.

The mechanics gate **is** live: production entry computes the immediate round
trip from two measured settlements and refuses above `maxRoundTripLossBps`
(400). It refuses all 17 cliff cases and admits the 54–109 bps ones. Previously
the number was computed correctly and recorded at `info` — the gate existed, the
measurement existed, and nothing connected them.

## 15. Production core call graph — NOT DONE

`paper.ts` still does not call `admitPortfolioEntry`. Its entry logic remains
duplicated. This is the largest remaining item and it is a prerequisite for a
live stateful label.

## 16. Explicit PnL fields — WRITERS DONE, NO ROWS

`insertPosition` and `updatePosition` now write `execution_cost_lamports`,
`gross_proceeds_lamports` and `net_pnl_lamports`, from the measured settlement,
with null meaning undetermined rather than zero. **Zero rows carry them**,
because no position has opened under the repaired code.

## 17–23. Trigger/later-fill, direct Pump clock, parity, Mayhem, entities, WSS, cohorts

Not started. Ordered behind a correct production generator, as the directive
sequences them.

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

1. `paper.ts` does not call `admitPortfolioEntry` (P8).
2. No live stateful buy→sell→close label from the running engine.
3. No live case above 2^53 atoms.
4. Token-2022 transfer/withheld fees unmeasured — 20 of 25 lifecycles
   disqualified as unknown-cost.
5. `expectedRecipients` is empty everywhere, so the unexpected-recipient check
   cannot bind (P4 requires it mandatory).
6. Offline Pump replay blocked; no Rust/LiteSVM worker.
7. Durable ordering state machine (P4) not implemented — a crash between
   runtime return and effect persistence still leaves an unrepairable cached job.

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
