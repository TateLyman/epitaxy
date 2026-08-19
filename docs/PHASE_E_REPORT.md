# PHASE E — MIRROR THE FRACTION, NOT THE EVENT

2026-08-19. Directive: `docs/directives/DIRECTIVE_33D303B9_PHASE_E_PROPORTIONAL_EXIT.md`,
committed verbatim before execution. Predecessor: PR #60 (`f58ef2e`),
`UNDECIDABLE_CENSORING`.

**Final state: `UNDECIDABLE_CENSORING`.**

**Proportional exit does not beat binary. Zero of twelve cells clear condition 5,
and per §1.2 that means nothing else in this phase matters.** The paired
difference — proportional minus binary, identical positions, identical lags, paired
on the same drawn days — is between **−1.27% and +4.17%** with every interval
straddling zero, and on the largest arm at 15s it is **significantly negative**:
−0.72% [−1.32%, −0.16%].

**And the premise this phase was built on was wrong before it ran.** Phase D
reported the wallet's realised return at 3–6× its first-sell return and concluded a
copier forfeits that gap. Measured on positions the wallet **fully exited**, the gap
has the opposite sign in every single arm:

| arm | wallet, first sell | wallet, realised | gap |
|---|---|---|---|
| MEAN f=0.01 | +15.53% | **+6.87%** | **−8.66%** |
| MEDIAN f=0.01 | +21.46% | **+16.14%** | **−5.32%** |
| MEAN f=0.001 | +76.04% | **+56.42%** | **−19.62%** |
| MEDIAN f=0.001 | +22.15% | **+18.60%** | **−3.55%** |

Phase D's 3–6× was computed on a set that included positions the wallet **never
closed**, where the realised figure carries a *mark on the unsold residual*. The gap
was the mark, not money made on later sells. On closed positions the wallet's later
sells are at **worse** prices than its first, so there was nothing for proportional
mirroring to recover — which is exactly what the paired difference then measured.

That correction is asserted by test (`tests/unit/phase-e-artifact.test.ts`) rather
than left as a paragraph, because it is the kind of premise a later phase would
otherwise inherit and build on again.

---

## 1 — THE PAIRED DIFFERENCE (§5.1, MT087 condition 5)

Proportional minus binary, on the identical position set, day-clustered and paired.

| arm | L | n paired | proportional | binary | **difference** | 95% CI |
|---|---|---|---|---|---|---|
| MEAN f=0.001 | 2s | 366 | +170.90% | +171.26% | −0.36% | [−3.59%, +3.49%] |
| MEAN f=0.001 | 15s | 356 | +18.62% | +18.05% | +0.57% | [−1.55%, +3.65%] |
| MEAN f=0.001 | 60s | 326 | +25.16% | +20.99% | +4.17% | [−2.91%, +15.31%] |
| MEAN f=0.01 | 2s | 7,317 | +10.39% | +9.08% | +1.30% | [−1.25%, +6.29%] |
| MEAN f=0.01 | 15s | 7,262 | −1.05% | −0.33% | **−0.72%** | **[−1.32%, −0.16%]** |
| MEAN f=0.01 | 60s | 7,086 | −1.80% | −0.97% | −0.82% | [−1.73%, +0.02%] |
| MEDIAN f=0.001 | 2s | 107 | +7.96% | +8.92% | −0.96% | [−3.84%, +1.13%] |
| MEDIAN f=0.001 | 60s | 106 | +3.59% | +4.86% | −1.27% | [−4.40%, +0.75%] |
| MEDIAN f=0.01 | 2s | 3,181 | +24.55% | +23.95% | +0.60% | [−0.40%, +1.71%] |
| MEDIAN f=0.01 | 15s | 3,175 | +6.35% | +5.74% | +0.61% | [−0.35%, +1.70%] |
| MEDIAN f=0.01 | 60s | 3,134 | +6.13% | +5.28% | +0.85% | [−0.65%, +2.61%] |

**Zero of twelve clear zero on a lower bound.** The MEDIAN f=0.01 arm — the one with
3.20 sell legs per position, where the mechanism has the most room to act — is
consistently positive at +0.60% to +0.85% and consistently fails to clear zero, its
lower bounds sitting at −0.35% to −0.65%. The mechanism appears to exist and to be
worth well under one percentage point.

**The magnitude is bounded by how often wallets sell more than once.** Sell legs per
position: **0.87** (MEAN f=0.001), **1.63** (MEAN f=0.01), **3.20** (MEDIAN f=0.01),
**3.46** (MEDIAN f=0.001). Where a wallet exits in a single leg, proportional and
binary are the *same estimand* by construction, so most of the MEAN f=0.01 sample
cannot express a difference at all.

**And the copier does mirror essentially the whole position where it mirrors at all**
— 95.9% to 100.0% of its opening unit is liquidated across the legs — so the null is
not an artifact of a partial mirror. It is asserted by test that this stays above
0.9, because a low figure would mean the estimand was measuring a partial exit and
calling it a round trip.

---

## 2 — COVERAGE (§5.2)

| arm | L | followable | entry priced | wallet closed | **paired** | legs/pos | mirrored |
|---|---|---|---|---|---|---|---|
| MEAN f=0.001 | 2s | 2,053 | 71.2% | 44.3% | **17.8%** | 0.87 | 96.4% |
| MEAN f=0.01 | 2s | 12,847 | 89.6% | 66.0% | **57.0%** | 1.63 | 99.4% |
| MEDIAN f=0.001 | 2s | 140 | 95.7% | 79.3% | **76.4%** | 3.46 | 100.0% |
| MEDIAN f=0.01 | 2s | 4,261 | 90.8% | 86.9% | **74.7%** | 3.20 | 99.3% |

At 60 seconds the paired share falls to 15.9% / 55.2% / 75.7% / 73.6%.

The paired set requires an entry price, the wallet's position reaching zero, and at
least one priceable sell leg. **Requiring the wallet to have fully exited is a
selection, and it runs in the favourable direction**: a wallet abandons a worthless
remainder rather than paying gas to sell it, so `is_closed` excludes precisely the
positions that went to nothing. That is why condition 2 exists, and it is why the
closed-only and residual-worthless figures are so far apart — +24.55% against
−11.30% on MEDIAN f=0.01.

---

## 3 — THE RETURN TABLE (§5.3)

All arms, all lags, both censoring treatments, and all three size arms are in
`docs/PHASE_E_CELL_LEDGER.csv` (36 cells) and `artifacts/phase-e-proportional.json`.
The ungated primary:

| arm | L | closed-only | 95% CI | residual worthless | n | need | conditions |
|---|---|---|---|---|---|---|---|
| MEDIAN f=0.01 | 2s | +24.55% | [−0.13%, +68.58%] | −11.30% | 3,181 | 13,263 | ‑‑3‑‑ |
| MEDIAN f=0.01 | 15s | +6.35% | [−1.11%, +14.49%] | −11.50% | 3,175 | 2,692 | ‑‑34‑ |
| MEDIAN f=0.01 | 60s | +6.13% | [−1.20%, +14.72%] | −12.44% | 3,134 | 3,238 | ‑‑3‑‑ |
| MEAN f=0.01 | 2s | +10.39% | — | — | 7,317 | — | ‑‑3‑‑ |
| MEAN f=0.001 | 2s | +170.90% | [−2.33%, +487.73%] | −59.68% | 366 | 2,360 | ‑‑3‑‑ |

**Condition 1 passes 0 of 12 ungated cells.** The closest is MEDIAN f=0.01 at 2s,
whose lower bound misses zero by 0.13 points — Phase D's best missed by 0.66. Two
cells satisfy condition 2, one satisfies condition 4, none satisfies condition 5, and
**no cell satisfies all five**.

---

## 4 — SLIPPAGE UNDER MULTI-LEG EXIT (§5.4)

The phase's second question: more legs means more slippage events, and whether that
offsets the recovered fraction.

| arm | legs/pos | entry mean | entry median | exit, weighted |
|---|---|---|---|---|
| MEAN f=0.01 | 1.63 | +4.89% | −0.30% | **−7.59%** |
| MEDIAN f=0.01 | 3.20 | +8.89% | +0.35% | **−4.69%** |
| MEDIAN f=0.001 | 3.46 | +4.77% | +3.41% | **−8.28%** |
| MEAN f=0.001 | 0.87 | +13.64% | −0.39% | −0.14% |

At 60 seconds the weighted exit slippage worsens to −10.47% / −5.88% / −11.02%.

**It offsets it completely.** The exit slippage is 4.7 to 11.0 points against a
proportional-minus-binary difference under 1 point. Every additional leg is another
sale into a bid the wallet has just taken, and the fraction recovered by mirroring is
an order of magnitude smaller than the slippage paid to recover it.

The extra fixed cost of additional legs — half a round trip's base-plus-priority fee
per extra leg, charged explicitly — is negligible beside that: about 6,047 lamports,
under 3 bps on a 0.02 SOL position. **The cost of multi-leg exit is slippage, not
fees**, and that is measured here rather than assumed.

---

## 5 — THE FRACTION OF THE GAP RECOVERED (§5.5)

The question is malformed on this data, and saying so is the answer: **the gap is
negative**, so there is nothing to recover. See the table in the header. The
`recovered` column in `pnpm prop:exit` divides a sub-one-point difference by a
negative gap and produces numbers between −25% and +32% that mean nothing; it is
printed for completeness and should not be read as a recovery rate.

What *can* be said cleanly:

- On fully exited positions, selling everything at the wallet's first-sell price would
  have **beaten** what the wallet itself achieved, by 3.55 to 19.62 points.
- The wallet's later sells are therefore worse than its first, which is what one
  expects from selling into declining liquidity.
- So the binary first-sell exit is not the crude approximation Phase D took it for. On
  this population **it is close to the best exit available from the wallet's own
  signals**, and Phase E's more faithful mirroring buys under a point of difference
  while paying multiples of that in extra slippage.

---

## 6 — THE INVERTED SIZE ARM (§2, MT088)

MT084 gated high-impact entries *out* and made the result worse. MT088 tested the
inversion, with the 3%-of-reserves threshold (measured impact ≥ 6% by the 2X
constant-product mapping) frozen before running.

| arm | L | size arm | kept | return | 95% CI | conditions |
|---|---|---|---|---|---|---|
| MEDIAN f=0.01 | 2s | UNGATED | 3,181 | **+24.55%** | [−0.13%, +68.58%] | ‑‑3‑‑ |
| MEDIAN f=0.01 | 2s | CONVICTION_GATED | 1,068 (33.6%) | **+15.48%** | **[+1.80%, +33.46%]** | 1‑34‑ |
| MEDIAN f=0.01 | 2s | CONVICTION_WEIGHTED | — | +0.62% | [−19.11%, +34.75%] | ‑‑3‑‑ |
| MEDIAN f=0.01 | 15s | CONVICTION_GATED | 1,065 | +14.38% | [+0.95%, +31.85%] | 1‑3‑‑ |
| MEDIAN f=0.01 | 60s | CONVICTION_GATED | 1,051 | +12.92% | [+0.20%, +30.03%] | 1‑3‑‑ |
| MEAN f=0.001 | 2s | CONVICTION_GATED | 83 (22.7%) | +54.37% | [−10.48%, +165.28%] | ‑‑3‑‑ |

**MT088 is not supported on its own preregistered criterion.** The criterion was
that the gated arm should *improve on ungated*, and its point estimate is **lower**:
+15.48% against +24.55%. Per MT088's own text, that closes the size dimension for
good — no third threshold, no fourth definition of impact.

What did happen is worth recording precisely, because it is not nothing:
**conviction gating cuts dispersion more than it cuts the mean.** Three gated cells
have a lower bound above zero where no ungated cell does, and one of them
(MEDIAN f=0.01 at 2s) also clears the power condition at n=1,068 against 972
required. It still fails conditions 2 and 5 and is therefore not copyable.

**And three of 36 cells clearing a one-sided lower bound is what noise produces.**
At α = 0.05 the expected count is 1.8, so three is inside the range of a search over
36 cells and must not be read as a discovery. The `CONVICTION_WEIGHTED` arm — the
same signal applied continuously rather than as a cut — is flat to negative
everywhere (+0.62% to −21.56%), which is the check that argues against a real effect:
if impact were genuinely informative, weighting by it should work at least as well as
thresholding on it.

---

## 7 — CREDITS, PER QUERY

| query | credits |
|---|---|
| Q8, first attempt (failed to compile: an unresolved column) | **0** |
| Q8 proportional exit mirroring | **245** |
| **Phase E total** | **245** |
| cumulative, all phases | 1,431 of 2,500 |

Target 400, ceiling 550, per-query limit 250 as raised in MT086 — **inside all
three**, at 98% of the per-query limit. A failed execution costs nothing, which is
why the compile error is recorded at zero rather than omitted.

Phase E was cheaper than Phase D despite doing more work per position: three lags
instead of six, one venue instead of two, and 60-second windows instead of
360-second ones. The reserve mark (§3) did not run, and correctly so — the directive
forbids it when the §1.2 paired difference fails, on the grounds that resolving
censoring on an estimand that has lost to its own control spends credits to sharpen a
number that is not going anywhere.

---

## 8 — LEDGER

- **MT086** — the per-query limit raised 150 → 250, *because Phase D measured the
  two-sided join at 230 and it cannot be calendar-bounded*, not because 150 was
  inconvenient. Landed before running. In the event, unused headroom of 5 credits.
- **MT087** — the five-condition rule, frozen before the first execution. Result: 0
  of 36 cells copyable; condition 5 fails on all 12 ungated cells; condition 1 passes
  none of them.
- **MT088** — the inverted size arm, threshold frozen before running. Result: not
  supported on its own criterion. **The size dimension is closed.**

Every cell examined: `docs/PHASE_E_CELL_LEDGER.csv`, 36 rows — 12 arm×lag cells × 3
size arms — each with its counts, both treatments where evaluable, the paired
difference, all five conditions, and the wallet's first-sell-to-realised gap.

---

## 9 — FINAL STATE

```
UNDECIDABLE_CENSORING
```

Formally: the closed-only and residual-worthless treatments still disagree in sign
(+24.55% against −11.30% on the largest arm), which is what that state names.

Substantively the phase is closed by **condition 5**, which is the stronger
statement: the change this phase existed to test does not beat the control it was
measured against, on any arm, at any lag. No threshold search follows, and none is
proposed.

### The closing account

The directive asks for this when the branch closes, and it is the deliverable.

**The follower penalty is real, measured, and large.** The wallet's advantage over
its own copier on identical legs is +16.83% [+12.87%, +21.86%] per position, 30 of 30
days (Phase D). It decomposes into a small entry cost and a large exit cost: at a
2-second lag the copier's entry is +7.32% mean but −0.00% *median* against the
wallet's own fill, while its exit is −6.24% mean and −0.75% median. **The cost is a
tail on entry and a level on exit.**

**The first-sell gap was an artifact of the mark.** Phase D's 3–6× realised-over-
first-sell ratio came from positions the wallet never closed, where the return
carries a mark on an unsold residual. On closed positions the wallet realises *less*
than its first sell, by 3.6 to 19.6 points. The binary exit was never the crude
approximation it looked like.

**The recovered fraction is under one percentage point and costs multiples of that to
collect.** Mirroring every fraction of every sell moves the paired difference by
−1.27% to +4.17%, never clearing zero, while the weighted exit slippage of the extra
legs is 4.7 to 11.0 points.

**Selection persists; execution does not transfer.** H1 stands: the top decile beats
the rest by +36.74% [+33.57%, +40.03%] per position out of sample, on 30 of 30 days,
surviving every adversarial re-cut available (PR #58). Phase C found a copier two
seconds behind keeps 0.725–0.779 of the appreciation *when it shares the wallet's
exit*. Phase D found that following the wallet's own exit drops that to 0.19–0.33.
Phase E found that mirroring the exit more faithfully does not help. **The
transferable part of the edge is the entry, and the entry alone is not enough to
clear a lower bound net of a 2.669% floor.**

**What remains unmeasured**, and would have to be measured before this idea could be
revived:

1. **Our own market impact.** Every price in Phases C–E is a VWAP of *other traders'*
   fills. Adding our own size to that pool would move it, and no query on a public
   tape can say by how much. Only the collector's own executable quotes can.
2. **An exit rule that is not the wallet's.** Every failure here is an *exit* failure.
   The wallet's own sells are a poor exit signal for a follower, and this programme
   has never tested a copier that enters on the wallet's buy and exits on its own
   rule — a stop, a target, a time limit. That is a different hypothesis and needs
   its own directive, its own preregistration, and its own hold-out.
3. **The open positions.** 13.1% to 55.7% of followable positions are never closed by
   the wallet, and their treatment moves the estimate from +24.55% to −11.30%. A
   reconstructed reserve mark would resolve that, and its own validation bar (p50
   within 1% of the stored bytes on the 142 pools, agreement above 95%) remains
   untested.
4. **Whether the wallet's sell is even observable at lag L in production.** An
   infrastructure question no query answers.
5. **Entity-level persistence.** H1 remains an **address-level** result. The
   entity-level re-run has been deferred since Phase C and is still deferred.

No mode changed. No gate moved. No wallet funded, nothing signed, no acknowledgement
file. `MEASUREMENT_ONLY`.
