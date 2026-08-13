# Simulation effects — what a simulation actually establishes

P3. A Solana runtime returning no transaction error proves the instructions did
not abort. It does not prove the trade happened.

`SIMULATED_OK` was read as "the leg works" by the exit gate, the shadow book and
the readiness check. It never meant that. Four separate questions were collapsed
into one column, and the collapse always erred in the same direction: toward
believing a leg was fine.

## The four checks

```
RUNTIME_OK             the instructions did not abort
EFFECT_OK              an output arrived, the debit was the intended one,
                       and nothing unexpected received value
FEE_DECOMPOSITION_OK   every lamport the fee payer lost is attributable
ACCOUNT_COVERAGE_OK    every writable the run touched was observed pre AND post
```

All four, and only all four:

```
SIMULATED_EFFECT_OK
```

`legIsExecutable()` requires it. `legIsConfirmatory()` requires it. A leg that is
`SIMULATED_OK` and nothing else cannot back a PnL-eligible fill.

## The required refusals

Each is a response the runtime accepted without complaint. Each is exercised in
`tests/unit/effect.test.ts`.

| refusal | what it catches |
|---|---|
| runtime succeeds but output delta is missing | the swap ran, charged the fee, debited the input, delivered nothing |
| runtime succeeds but output is below minimum | delivered less than the route's own stated floor |
| runtime succeeds but input debit exceeds maximum | spent past the caller's ceiling, which the runtime has no opinion about |
| runtime succeeds but an unexpected writable receives value | a skim: every asserted party is whole and value left to an address nobody named |
| runtime succeeds but any writable account was unobserved | a delta that cannot be computed is being read as zero somewhere downstream |

## Absence is not zero

`delta()` treats a missing balance as **unknown**, never as zero. Reading a
missing post-balance as zero turns "we did not look" into "it went to nothing" —
the same error that made every rejected token appear to go to zero in reject
tracking, and it always flatters whatever produced it.

A fee component that was not reported fails `FEE_DECOMPOSITION_OK` rather than
defaulting to zero. A cost the model does not know about is exactly what turns a
positive backtest into a negative live account.

## What is persisted

Per job, in `simulation_jobs`, written whether the verdict passed or failed:

pre/post SOL balances, pre/post token balances, exact input debit, exact output
credit, base fee, priority fee, broadcaster tip, rent created, rent recovered,
transfer fee, withheld fee, created accounts, closed accounts, unexpected
movement and its recipients, unobserved accounts, bounds violations, the four
check results, the composite, and the refusal list.

Stored rather than derived on read. A verdict recomputed later is recomputed
under whatever the code believes today, and the question a job has to answer is
what was actually established at the time.

## Development JIT is not confirmatory

A JIT run fetches its own state from a moving chain, so the same transaction run
twice is two experiments. `SIMULATED_EFFECT_OK` on a JIT run is real evidence
about the strategy and is never sufficient for canary. The evidence classes are
kept separate and are never aggregated:

```
STRUCTURAL_ONLY  ->  JIT_EFFECT_VALID  ->  OFFLINE_REPRODUCIBLE  ->  CONFIRMATORY
```

## First findings from the repaired instrument

2026-08-13, the first ten `VALID_DEVELOPMENT` jobs — the first in this
repository's history whose request described an economic leg.

```
side  status              effectOk  n
buy   SIMULATED_OK        0         1
sell  SIMULATED_OK        0         1
sell  SIMULATION_FAILED   0         8
```

**Zero of ten passed effect verification**, and the reasons are specific.

### Runtime-OK with zero output

Both runs the runtime accepted were refused, and the daemon's own bounds check
agrees with the verifier independently:

```
runtime succeeds but output delta is missing
asserted bounds violated: token delta 0 below the asserted minimum 18719272
asserted bounds violated: token delta 0 below the asserted minimum 14896738780
```

The swap executed, charged the fee, and delivered **nothing**. No transaction
error, so `SIMULATED_OK`.

This is the whole reason P3 exists. Under the old code these would have been
booked as working legs, and the 40 pre-repair "successful" buys may well have
been the same thing — nobody will ever know, because nobody looked.

### The unexpected-movement check was unpassable

The first version refused whenever any account gained lamports. Every AMM swap
moves lamports into pool vaults, so it refused every successful trade.

A gate that cannot pass is a wall, and a wall dressed as a gate teaches everyone
to route around it. It now refuses only against a **stated** model — when the
caller says who was expected to receive value — and the movement is measured and
persisted either way. Finding a skim means looking at that number against a
route plan, not asserting in advance that nothing may move.

Narrowed with a reason, not weakened to make something pass: the output-delta,
below-minimum, debit and coverage refusals all still fire, and they are what
refused these ten.

### Fee decomposition on failed runs

`fee decomposition incomplete: no priority fee reported` appears on every
runtime failure. A transaction that aborted has no priority fee to decompose, so
this is correct and not a daemon gap — it is `FEE_DECOMPOSITION_OK` refusing to
report a number it does not have. On the two runs that reached the runtime, fee
decomposition passed.
