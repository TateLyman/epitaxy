# Upgrade ROI

What each candidate upgrade would actually buy, what it would not buy, and the condition
under which buying it becomes rational. Costs are stated as of 2026-08-11; where a price is
not verified it is left blank rather than guessed.

The master constraint is that **no paid subscription may be a hard dependency**. So every
row here is an *optional* upgrade: the system must continue to run, degraded, without it.
An upgrade that becomes load-bearing has violated the constraint no matter how much it
improves throughput.

---

## The ordering rule

There is one upgrade whose absence dominates every other, and it cannot be bought:

**A7 — that an exploitable pattern exists in the 120s–3600s window — is unproven.** As of
2026-08-11 there are 10 closed positions, all simulated, 1 of them a winner, net
−0.248 SOL on 0.487 SOL deployed. Ten is not a sample; it establishes nothing about
expectancy in either direction and must not be quoted as a result. Every purchase below
multiplies throughput, coverage, or resolution *of a process whose expectancy has never
been measured*. Multiplying an unknown by a larger number produces a larger unknown.

What those ten *do* carry is a diagnostic: **8 of 10 exited on `exit_cost_exploded`** —
forced out because exit price impact breached the cap, not because price moved against
the thesis. If that pattern survives a real sample, the binding problem is that entries
are admitted into liquidity that cannot support the exit, and **no upgrade on this page
addresses it.** It is a threshold question (A10, MT005), and it is free to investigate.

So the rule is: **no paid tier is purchased until a paper-mode sample exists that could
have falsified A7 and did not.** Until then the only upgrades worth making are the ones
that cost engineering time rather than money, and the ones that protect the corpus — which
is the single artifact that cannot be regenerated.

---

## Free upgrades, ranked

These cost only time and are worth doing before anything is bought. They are ordered by
harm-if-left-undone, not by effort.

| # | Fix | Closes | Why it ranks here |
|---|-----|--------|-------------------|
| 1 | `pnpm reconcile` takes the process lock | O024 | Two writers mutating position state is a corrupt ledger, and the ledger is the thing that survives. This is a live hazard *today*, not a future one. |
| 2 | A backup that is actually a backup | O017, A15 | `db.ts:335` already copies the file on every non-readonly open, so this reads as done and is not. It does not checkpoint the WAL, does not copy `-wal`, overwrites the previous copy every run, and swallows its own failure in an empty `catch`. The corpus is the only irreplaceable artifact; a backup believed in but not working is the worst available state. |
| 3 | Sleep/resume and clock-skew detection | O012, D015, A17 | A host that sleeps an hour and wakes computes every age an hour too old, and silently selects a different population. There is no detector. This corrupts the corpus *without any error surfacing* — the worst failure shape available. |
| 4 | `pnpm doctor --mode=` | O023 | Doctor currently validates the default config, so it can pass while the config that will actually run is broken. A green check on the wrong file is worse than no check. |
| 5 | `evidence.replayCorpus` counts divergences, not snapshots | S022 | The gate advertises "0 divergences" while measuring something else. A gate that overclaims is how a promotion decision gets made on evidence that was never gathered. |
| 6 | Disk-full and antivirus-quarantine handling | O006, O018 | Windows host; both are ordinary, not exotic. |
| 7 | Take the free Jupiter Portal key | O029 | 2x throughput for no money and no new dependency. Ranked last deliberately: it multiplies an unmeasured expectancy, so it is the only row here whose value is contingent on A7. Done 2026-08-12. |

Items 1–3 protect *what has already been collected*. Items 4–6 protect *the honesty of the
promotion decision*. Neither category needs a hypothesis to be true to be worth doing,
which is exactly why they come first. Item 7 is the exception and is ranked accordingly.

---

## The free Jupiter key, which this page originally missed

Amended 2026-08-12. When this page was written it recorded Jupiter as `auth: none` at
0.5 rps / 30 rpm and treated *any* relief from that ceiling as a purchase. Re-verification
against `developers.jup.ag/docs/portal/rate-limits` found a **free Portal-keyed tier at
1 rps / 60 rpm** — double the throughput, at no cost, from a key that requires no card.

That is the cheapest upgrade on this page and it was invisible because the matrix recorded
the keyless limit as though it were the only limit. Worth noting how the error happened:
the figure was verified correctly, and the *tier structure around it* was never asked
about. A verified number can still be the wrong number.

Two things it does not change. It does not make a subscription load-bearing — the keyless
path is still the default and still works, so the master constraint holds. And it does not
touch the ordering rule below: doubling throughput still multiplies an unmeasured
expectancy. It is worth taking only because it costs nothing, not because it improves the
odds of anything.

It also surfaced O029: `withKeyRequestsPerSecond` was already set to `1.0`, exactly at the
newly-discovered ceiling, in breach of the "strictly UNDER" rule this repo states in
`config/source-limits.json`. It had never been wrong in practice only because no key
existed to make the keyed branch reachable. Now lowered to 0.8.

---

## Paid Jupiter tier

**Buys:** relief from 1 rps / 60 rpm on the free keyed tier — the Developer tier is 10 rps
at $25/mo, Launch 50 rps at $100/mo, Pro 150 rps at $500/mo (verified 2026-08-12). Note
that the baseline this is measured against is now the *keyed* figure, not the 0.5 rps
keyless one this section originally cited, so the marginal gain from paying is 10x rather
than the 20x implied before.

That ceiling is the reason the gate stack is split into a cheap layer and an expensive
layer at all — a round-trip quote costs two of the scarcest thing the system has, so
`maxQuotesPerCycle` is 4. With the ceiling relieved, the cheap/expensive split could
collapse into a single stage and every eligible candidate could be quoted rather than the
top four by cheap score.

**Does not buy:** a better strategy. It buys *more decisions per hour at the same
expectancy per decision*. If expectancy is negative, this upgrade loses money faster. If
A8 is false and the soft-risk weights do not rank usefully, quoting all candidates instead
of the top four converges the selected set toward random — the ranking is currently the
only thing making the truncation non-arbitrary.

**Second-order cost:** it makes the cheap/expensive architecture look like unnecessary
complexity, and the pressure to delete it will be real. That architecture is what lets the
system run at all on the keyless tier, i.e. it is the thing enforcing the master
constraint. Deleting it makes the subscription load-bearing.

**Buy when:** paper mode is quote-starved *and* A7 has survived a sample. The diagnostic
is the count of candidates that passed cheap gates and were dropped for quote budget
rather than on their merits. If that number is near zero, the ceiling is not the binding
constraint and this purchase buys nothing.

---

## Paid RPC (Helius or equivalent)

**Buys:** headroom for on-chain reads. The authoritative top-holder measurement is
`getTokenLargestAccounts` on chain (A5) — the provider figure counts the liquidity pool as
a holder and cannot distinguish a whale from an unmigrated launchpad token. Several
register rows in the pool and token categories are `designed_not_implemented` for want of
affordable on-chain calls: creator LP retention (P005), lock/burn semantics (P006),
shared-funder clustering (P012), bundle concealment (P013).

Those four are not throughput improvements. They are **new evidence about whether a token
is a trap**, which is a different and better category of purchase than "more of the same
decisions."

**Amended 2026-08-12: most of this may be free.** The Helius free tier is 10 req/s and 1M
credits per month, and standard RPC calls cost 1 credit each. At one `getTokenLargestAccounts`
per screened token, 1M credits is far more than this system consumes — so the premise that
those four rows are blocked "for want of affordable on-chain calls" is probably wrong, and
they are blocked for want of *implementation*. That reclassifies them from purchases to
free upgrades, and the honest next step is to measure actual credit burn over a week of
observe mode rather than to reason about it.

The one genuine trap is DAS. It sits on the same host and looks like the same resource, but
it draws from the *same* 1M pool at **10 credits per call**. Rate headroom is not credit
headroom: 2 req/s sustained against the DAS bucket would exhaust a month's allowance in
under a day. Anything built on DAS needs a credit budget, not just a rate bucket.

**Does not buy:** streaming. `blockSubscribe` is not supported on any Helius tier
(verified 2026-08-11). Nobody should buy this expecting to move toward a push
architecture — there is no WebSocket anywhere in this codebase, and D012/D013 are recorded
as `not_applicable_current_architecture` for that reason.

**Also does not buy:** a fix for A17. The public Solana RPC returns no `Date` header, so it
is unusable as a clock reference; a paid endpoint that returns one would help, but NTP is
free and solves it properly.

**Buy when:** the honest question is whether the rejections these checks would produce
overlap with rejections the existing gates already make. That is measurable *before*
purchase, on the corpus already collected, by hand-checking a sample of tokens the current
stack admitted. Buying first and measuring after is how a subscription becomes permanent
regardless of whether it earned anything.

---

## A second independent data provider

**Buys:** a resolution to D024 — conflicting state between two providers — which is
currently `designed_not_implemented` and is the only row here that *cannot* be closed by
one provider at any price.

DexScreener is already configured as corroboration, never as sole authority. Making it a
genuine cross-check means defining what happens on disagreement, and the only safe answer
is that disagreement is a veto: two sources that contradict each other are not two sources,
they are zero. That fails closed and costs eligible candidates.

**Does not buy:** independence, necessarily. Two indexers reading the same chain through
similar pipelines share failure modes. A cross-check between correlated sources
manufactures confidence rather than evidence — which is worse than a single source
honestly labelled as single.

**Buy when:** never as a subscription, on the current constraint. DexScreener's free tier
is 300 req/min, an order of magnitude above what this system needs. This is engineering
time, not money.

---

## Host and infrastructure

**Buys:** closure on the environmental assumptions that are currently unguarded and
undetected — A15 (no backup), A17 (clock correctness), plus O006, O012, O018.

An always-on host with NTP, a UPS, and an off-machine backup target closes the entire
environmental cluster. Of everything on this page it has the best ratio of
failures-eliminated to money-spent, and it is the only category where the failures are
*certain* rather than hypothesised: a Windows desktop will sleep, and a disk will fill.

**Does not buy:** anything strategic. It converts a class of silent corruption into a class
of loud unavailability, which is the correct direction.

**Buy when:** now, if at all, because it is the one upgrade whose value does not depend on
A7 being true. If the strategy has no edge, a correct clock and an intact corpus are what
let that be *proven* rather than merely suspected.

---

## Explicitly rejected

**Co-location, priority-lane bidding, or any latency purchase.** The master prompt forbids
competing in a first-block race, and the 120s floor in the age window exists precisely so
that latency is not the axis of competition. Buying latency here would not improve this
strategy; it would replace it with a different one that this system is not built to run and
whose failure modes are not in the register.

**A paid tier bought to make a failing gate pass.** If a gate rejects too much, the
question is whether the gate is wrong, and that is answered with a hold-out sample and a
row in the multiple-testing ledger — not with a purchase that changes the population and
makes the prior sample non-comparable.

---

## What would make this page wrong

If a paper-mode sample establishes positive net expectancy against a buy-and-hold-SOL
benchmark, the ordering rule at the top dissolves and the Jupiter tier moves to the front,
because throughput would then multiply a measured positive rather than an unknown.

If the sample establishes the opposite, nothing on this page should be bought at all, and
the correct next expenditure is on a different hypothesis — which needs its own row in
`MULTIPLE_TESTING_LEDGER.csv` before it is tested, not after.
