# Accounting semantics

P12. One definition of every quantity, in one module, with the three that used
to be confused kept apart on purpose.

## The three quantities that must never collapse

```
gross_proceeds_lamports   what the exit returned, before any cost
execution_cost_lamports   what it cost to EXECUTE: fees, tip, unrecovered
                          rent, failure cost
net_pnl_lamports          the result: gross minus cost minus basis
```

They are three columns because they were one. `realized_lamports` was read as
gross by one caller and as net by another, and the readiness gate computed
`realized - cost` against a column that already held the net — so a position
that cost 20,000,000 and made 1,000,000 scored as a **19,000,000 loss**, and
profit factor, log growth, drawdown and every robustness check inherited it.

A column whose meaning has to be inferred from its caller will be inferred
wrongly.

## Entry cash out

```
exact input
+ base fee
+ measured priority fee
+ route-specific tip
+ rent created
+ transfer fee not already embedded
+ explicit platform fee not already embedded
+ expected failure cost
```

Rent is **locked capital, not a loss**. It leaves the free balance and comes
back when the account closes. Counting it as a cost double-charges a round trip
that recovers it; counting it as free understates the capital a position ties
up. It is its own number.

## Exit cash in

```
exact output
- base fee
- measured priority fee
- route-specific tip
- transfer fee not already embedded
- close fee ONLY if a separate transaction is required
- expected failure cost
+ rent actually recoverable
```

A close riding the exit transaction pays **no second signature**. Charging one
is a fabricated cost, and 5,000 lamports against a 0.02 SOL leg is 2.5 bps of an
edge measured in hundreds.

## Unknown is not zero

An unobserved transfer fee or platform fee makes the quote `complete: false`. It
is never zero. A Token-2022 transfer fee read as zero understates every cost it
touches, and it is exactly the extension a memecoin is most likely to carry.

In confirmatory data an unknown cost is disqualifying, not merely noted.

## The failure model is a bound, not a flat charge

`assumedFailedAttemptLamports` charged the same amount on every leg. That is
wrong in both directions at once: it charges a cost that usually does not
happen, and charges the same whether the conditional cost is a 5,000-lamport
signature or a 1.4-million-unit priority fee.

`failureUpperBound()` distinguishes 3-in-10 from 300-in-1000 — which share a
point estimate and are very different evidence. With no attempts the bound is
**1**, so an unproven leg is charged a full failure. That is the honest answer,
and it makes collecting the history worth something.

## One loss model for existing and proposed positions

A proposed trade was charged `plannedLossFractionBps()` — the maximum of the
stop, the observed severe loss and the catastrophic floor, currently 100% — while
existing positions in the *same aggregate cap* were charged the nominal 2,500 bps
stop. A new trade was charged four times what an identical existing one was, and
the cap read the book as four times safer than the model said.

A stop is a hope about where the exit fills. In a token that goes to zero, no
stop fills anywhere.

## The cost stress doubles costs

`2×` costs means doubling **fees, tip, unrecovered rent, failure cost and latency
cost**. It does not mean subtracting the principal again. The earlier version
removed the entire 20,000,000 basis rather than the 13,000 of execution cost, so
no strategy could pass — which is not a conservative test but a broken one. A
stress that always fails carries no information about robustness.

## Exact arithmetic

Every lamport and every raw token amount is `bigint` end to end, and persists as
TEXT because SQLite INTEGER is 64-bit **signed**. Nothing sums lamports through
`Number`. Ratios may use floats; totals may not.
