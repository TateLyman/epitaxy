# Jupiter Developer plan — measured ROI

P21 / P23. Do not buy infrastructure without a measured ROI. This is the
measurement.

## The measured shortfall

From `health_events`, in the fifteen minutes after the repaired engine restarted
on 2026-08-13:

```
shadow_mark_backlog  169-172 positions due against a capacity of 4
                     worst lag 1017-1030 s
```

Mark interval is 10 s. At four marks per cycle that is 24 marks/minute, so a
full sweep of 170 positions takes just over seven minutes, and the oldest mark
in the book is seventeen minutes stale.

For a strategy whose stop is 2,500 bps and whose maximum hold is 30 minutes, a
seventeen-minute-old mark is not a mark. It is a memory.

## What P9 costs

The decision-bearing mark is now an exact full-balance `BUILD_CUSTOM` sell
observation rather than an `/order` quote. That is strictly more expensive — a
build is a heavier call than a quote — and it is not optional: the previous mark
was a router's opinion about a swap nobody built, and every stop, trail,
take-profit, collapse, peak and NAV in the system read it.

So the repair increases per-mark cost while the backlog is already 40x capacity.
The tension is real and is stated rather than hidden.

## The three options, honestly

**1. Shrink the book.** Fewer shadow positions, marked properly. Costs nothing,
reduces sample size. A smaller sample of valid marks beats a larger sample of
marks that are seventeen minutes old, because the second is not a sample of
anything.

**2. Widen the mark interval and record the gap.** The mark scheduler already
reports the backlog rather than silently degrading, which is the P10
requirement. Widening the SLA and recording it is honest; leaving the SLA
nominal while missing it is not.

**3. Buy throughput.** This is where the ROI question lives.

## Is the Developer plan justified?

**Not yet, and the reason is not the price.**

The gating fact is that there are currently **zero** effect-verified legs in the
corpus. Every simulation job is `INSTRUMENT_DEVELOPMENT`. Buying throughput now
buys a higher rate of measurements that are not yet known to measure anything.

The purchase becomes justifiable when both hold:

1. a Pump fingerprint has reached `JIT_EFFECT_VALID` and is producing
   effect-verified round trips at a measurable rate; and
2. the binding constraint on collecting the 200 confirmatory positions the
   readiness gate requires is demonstrably the rate limit, not the strategy's
   own eligibility rate.

Today the binding constraint is unknown, because the instrument was only just
repaired. Spending money to accelerate an unvalidated measurement is the
expensive version of the mistake this whole session was about.

## What to measure before deciding

- effect-verified legs per hour, by fingerprint, once the repaired window has run
- the fraction of cycles where a mark was skipped for want of budget
- the fraction of `HTTP_4XX` sell observations, which cost budget and return
  nothing — 92 in fifteen minutes, and a route that does not exist is not a rate
  problem

That last number matters most. If most of the spend is going to sells that have
no route, more throughput buys more of the same nothing.
