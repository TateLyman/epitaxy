# CURRENT STATE — the durable handoff

**Written 2026-08-20. Updated in place. This file exists so that nothing is lost if working
context is compacted or a session ends. If you are picking this up cold, read this file first and
`docs/MULTIPLE_TESTING_LEDGER.csv` rows MT101–MT110 second.**

Branch: `analysis/low-capital-profit-path`. Everything below is committed there.

---

## 0 — THE ONE-PARAGRAPH SITUATION

The programme spent fifteen months measuring memecoin trading and found every expectation
negative. In the last day we built a free, verified, real-time instrument over the whole PumpSwap
venue, discovered two free bulk-history sources, corrected four published numbers that were wrong,
and invalidated our own first experiment before it could report. **No trading edge has been found.
No position has ever been taken. Nothing is funded and nothing is signed.** What exists that did
not exist yesterday is an instrument that makes a test cost hours instead of a month.

---

## 1 — WHAT IS RUNNING, WHAT IS STOPPED

| thing | state |
|---|---|
| `pnpm venue:collect` — the venue tape | **STOPPED.** Four duplicate processes were found and killed (see §5). Restart deliberately, ONE only. |
| `pnpm watchlist:sweep` — MT101 polled source | stopped, ran its full 6h |
| MT104 copy arm | **INVALID, halted.** See §4. Its 42 positions are not evidence. |
| MT110 impact reversion | **CLOSED NEGATIVE.** See §6.6. |
| MT111 depth-conditioned reversion | **CLOSED** on a 12-day holdout. See §6.7. |
| MT112 LP on complete coverage | **CLOSED**, control 1 failed. See §6.8. |
| collector / engine / trajectory collector | not running |
| Dune | 2 queries executed (Q13, Q14). Account 2 has headroom; account 1 is capped. |

**Nothing capital-bearing has ever run.** `canary` and `live` remain blocked by
`.claude/hooks/guard.mjs` and the acknowledgement-file requirement.

---

## 2 — THE INSTRUMENTS WE NOW HAVE (all free, all verified by direct probe)

1. **Venue tape.** `logsSubscribe` on `pAMMBay…` at `wss://api.mainnet-beta.solana.com`. 472
   notifications/s sustained, zero log truncation. Anchor events decode from `Program data:` log
   lines — `BuyEvent`/`SellEvent` carry `user`, `pool`, both quote legs, pool reserves BEFORE the
   trade, and the full fee ladder. **Decode verified against pool-vault balances in the same
   transaction at 55/55 exact, zero tolerance.** Code: `packages/intelligence/src/pumpswap-event.ts`,
   `venue-stream.ts`. Reproduce: `pnpm venue:probe`, `pnpm venue:verify`.
2. **SQD Portal backfill — BUILT AND VERIFIED.** `scripts/sqd-backfill.ts`. The key finding is that
   filtering the Anchor `emit_cpi!` self-CPI discriminator `0xe445a52e51cb9a1d` server-side is **1.7x
   cheaper than asking for account keys and strictly more informative**: the payload carries `pool`,
   `user`, both quote legs, reserves BEFORE the trade, and the full fee ladder, and the same pass also
   catches `DepositEvent`/`WithdrawEvent` — which MT106 needs and has never had at scale. Measured
   **456 slots/s, 707.8 B/instruction, ~26,000 events/s**; 30 days is 3h47m and ~200 GB. The decoded
   `pool`/`user` are byte-identical to `accounts[0]`/`accounts[1]` fetched the expensive way.
   **Independently re-verified here by reserve chaining: the BASE leg closes EXACTLY on 35,650 of
   35,650 adjacent pairs, zero tolerance** — so the ordering key (slot, transactionIndex,
   instructionAddress) and the offsets are both right. What it does NOT carry is the pool's MINTS;
   those need `getAccountRaw`, and an unresolved pool must be refused, never assumed WSOL.
3. **ClickHouse CryptoHouse.** `https://crypto-clickhouse.clickhouse.com/?user=crypto&password=`,
   no signup. Free SQL over all Solana since 2020-10-07. `solana.transactions_non_voting` carries
   pre/post token balances with `owner`. Per-query caps: 10e9 rows, 60 s, 1000 result rows.
4. **The corpus.** 9.4 GB, 87 tables. Notably `reject_tracking` holds **1,251,883 priced forward
   observations over 158,075 mints** out to 24 h — an outcome panel 2,750× the size of the 455-row
   executable instrument every prior conclusion rests on.

**Not available:** Helius WebSockets (free plan refuses the upgrade; control passed, so it is a plan
limit not a network fault). Helius `getSignaturesForAddress` is rate-refused at 0/20; the QuikNode
primary serves it 20/20 at 2.56 req/s — the reverse of what `config/source-limits.json` said, now
corrected there.

---

## 3 — CORRECTIONS TO PUBLISHED NUMBERS (all verified against the DB)

These matter more than any finding, because other conclusions were built on them.

| was published | is actually | where |
|---|---|---|
| "−17.44% mean, −18.6% median, SD 41.8%, p10 −69.6%, n=455" | **no single population produces that triple.** notional basis n=455: mean −17.44%, median **−2.68%**. cash-out basis n=229: mean −17.83%, median −18.64% | `LOW_CAPITAL_PROFIT_PATH.md` §10.1 |
| baseline −17.44% | **−8.31%** for positions sized inside the pool (n=381). −64.42% for those that were not (n=74). **122 of 685 entries took >50% of the pool they entered** | §10.2 |
| cost floor 250 bps | property of the sampled slice. 79.1% of live venue trades are lp20/proto5; **43.4% of buy legs pay <50 bps a leg** | §10.3 |
| rent is a per-position cost | `WALLET_GLOBAL` and `WALLET_QUOTE_MINT` are **one pubkey each**, charged 640 and 199 times. 1,942 bps if booked per position, **4.7 bps amortised** | §10.4 |
| bottom-tier round trip 250 bps | **246.9 bps** — a buy pays f/(1+f) of input, not f | `copy-fill.ts` tests |
| MT101 "is dead" | **it is not.** 12.04 FORWARDED/day against a 5/day kill threshold | commit `c00a80e` |
| "pools don't drain in the hour, 360/362" | true of the *collector-admitted* population only. On the wallet-traded population **7.0% of 540 pools fall below 10%** of starting quote reserve | commit `c00a80e` |
| MT104 decision in "2–4 days" | **~10 day clusters minimum.** At 2 clusters the bootstrap false-positive rate is **25%** against a nominal 2.5% | MT108, `pnpm cluster:power` |
| H\* = 3600s | wallets followed hold a **median 103 s**; 96.4% out inside the hour. Amended to 120 s | MT109 |
| "the LP fee is a cost that leaves the pool" | **the LP fee ACCRUES TO THE POOL.** On sells the realised reserve fall is gross x (1 - lp), implied 20 bps p25-p75 20-25 against a declared full ladder of 30 — only protocol and creator leave. 100% of 17,724 sells are consistent | `scripts/diagnose-quote-fields.ts` |
| a cheap-fee tier of pools clears at +3.41% | **confound, retracted the same hour it was found.** At pool level that tier is 6 pools, every one deep, and the shallow-and-cheap cell is EMPTY — fee and depth were perfectly collinear | `scripts/reversion-per-pool.mjs` |

---

## 4 — WHY MT104 WAS INVALIDATED

Found by an adversarial review agent, verified. The bridge was not running the preregistered
experiment:

- **`evaluateSignal` was never called** on the stream path — no gates, no lag budget, entry modelled
  at **zero latency** (which inverts the stated "this is a lower bound" bias into an optimistic one).
- **"One position per mint" was global, not per-arm** — 573 pools traded by both deciles, **0 mints
  in both arms**. Arrival order decided which arm got each mint: the exact latency selection MT105
  says it rejects.
- **The exit mark is anchored to when a flagged wallet last traded** — the behaviour under test.
  Effective horizons: decile 1 **2,022 s**, decile 10 **1,274 s**. Not the same holding period.
- **The reported decile gradient does not exist.** −51.75% vs −71.36% pooled is **19.6 points**;
  like-for-like on `TAPE_RESERVES` it is **1.6 points**. The gap was composition in the censoring
  rule, with zero decile-1 rows in the favourable stratum.
- **41% of positions unpriceable, differentially** (55% of decile 1, 32% of decile 10) — the arm
  reproduced the censoring defect it was built to remove, and wrote no refusal rows.
- **Sampling ran ~10× under target** (draws are per distinct (mint,wallet) pair, 12,166, not 45,930
  buys) and `p` drifts between runs without being stored, so refusals are **not** recomputable
  despite a comment of mine claiming they are.

**Fix list before any restart:** route stream candidates through `evaluateSignal`; key dedupe on
`(ledger_row, arm, mint)`; treat no-coverage as `UNPRICEABLE_NO_COVERAGE` not zero drift; store the
exit's real timestamp and its own fee ladder; calibrate `p` on distinct pairs and freeze it; enforce
one collector via the existing DB lock.

---

## 5 — OPERATIONAL TRAPS ALREADY PAID FOR

- **`TaskStop` kills the shell, not the `node` leaf.** Four `venue:collect` processes were running
  concurrently, double-counting the session denominator. This is S096 in this repo's own docs. Kill
  by command-line match via PowerShell `Get-CimInstance Win32_Process`, and verify zero remain.
- **Migrations take a full ~9.2 GB backup.** ~15 minutes each. `tests/unit/migrations-apply-cleanly.test.ts`
  now validates every migration against an in-memory DB in 271 ms — run `pnpm check` before migrating.
- **Backticks and `$` inside shell heredocs get expanded** even in `node -e` strings. Two documents
  were mangled this way. Write file content with the Write tool, not through the shell.
- **Migration SQL lives in a template literal** — a backtick in a SQL comment silently truncates it.
- **secretscan flags Solana signatures** (87–88 base58 chars ≈ an ed25519 key). Store a 64-char
  prefix in committed artifacts; the full signature belongs in the DB, which is gitignored.
- **`pnpm dune:assemble` was broken on this checkout** (CRLF vs `/--.*$/`). Fixed; it now reproduces
  all committed queries byte-for-byte.

---

## 6 — WHAT HAS BEEN TESTED AND FOUND NEGATIVE

Ranked by how firmly closed.

1. **Copy-trading on wallet identity.** Closed on convergent evidence: Luo et al. (WWW '26) **prove**
   a copier on a convex curve mechanically overpays, and their LASSO/XGBoost/NN baselines all return
   negative — independently reproducing our Phase G −4.28%. The only published identity-decay curve
   peaks at 200 ms with ~84% gone by 30 s. Our own tape: the confirmed-skill wallets hold a **median
   103 s** and are substantially the deployer-funded sniper cohort (Pine: 87% win rate, >55% out
   under 60 s) whose edge is same-block privilege.
2. **The forward-price drift on admitted tokens.** A corpus agent reported +6.90% median over
   5m→15m (n=341). **It does not replicate.** Independently: n=44, mean +7.66%, **median −0.46%**,
   43.2% positive, 3 days with one day carrying it. And the contrast was a **liquidity confound** —
   only 15.7% of rejects move at all; against rejects that *did* move, the admitted advantage is ~1
   point of mean on a negative median. Same admissions at 24 h: **median −87.74%**.
3. **The gate regression (v0.4.0 → v0.6.0).** Also does not replicate: I get v0.4.0 −7.01% and
   v0.6.0 −0.35%, not +12.45% vs −7.69%. All cells n≤15 on 1–2 days.
4. **Crowding as a killer.** `NOT_DEMONSTRATED` on the preregistered conjunction (MT107) — but the
   price half is real and is now the measured quote-to-land cost: **+57.7 bps median at 2 s** after a
   flagged buy against +0.8 for a control, decaying to +19.5 bps by 45 s.
5. **LP on freshly-migrated tier-0 pools.** MT100: LVR 47× fee income, break-even 93.7 bps against
   22 available.
7. **Depth-conditioned reversion (MT111), on a 12-day holdout of complete venue coverage.**
   CLOSED: 53.6% of deep pool-days positive against the 60% required, and a day-clustered interval
   of **[−0.04%, +0.77%]** that straddles zero. The effect shrank ~80% out of sample — fit 13 of 18
   at +1.83%, holdout 53.6% at +0.35%. **But the by-product replicated overwhelmingly and is the
   single most useful number this programme has: pool DEPTH separates 53.6% positive from 5.0%
   positive, and +0.35% from −6.68%.** The shallow arm loses on 95% of pool-days on every one of
   twelve days, daily medians −4.64% to −20.34%. Anything transacting here outside deep pools pays
   ~6.7% a round trip, and no edge ever measured here is worth 6.7%. Evidence: 34,061 priced round
   trips, 4,417 pools, 26.4M decoded trade events, zero unresolvable, zero unpriceable.
8. **LP on deep, mature, high-fee pools (MT112).** CLOSED, and **its preregistered CONTROL 1
   FAILED, so its magnitude is not quotable** — fee income does not rise with the fee tier
   (0.0937% at lp=2, 0.0817% at lp=20, an impossible −9.45% at lp=25). A turnover-composition
   confound could explain that, but the control existed to forbid exactly that rescue. The SIGN
   survives because it needs no fee isolation: negative on 3,655 segments, every tier, all twelve
   days, positive share never above a third. Median fee 0.085% against median rebalancing −1.222%,
   a ratio of 8 to 1 — against MT100's 47 to 1 on tier-0. **The self-void did NOT trigger: k
   decreases in 3.622% of 25.7M steps against a 5% bar and against the 30.8% that voided MT106
   twice.** The instrument is finally sound and the answer is simply no. Known defect for a
   successor: v is fitted as a global 17.5845 SOL when it is a per-pool quantity.
6. **Temporary-impact reversion, unconditional (MT110).** The net executable round trip is negative in
   24 of 25 preregistered cells, medians −1.5% to −3.8%. **But its preregistered check (a) PASSED**: the
   share of positive round trips rises monotonically with impact — 17.1, 27.8, 35.0, 39.5, 49.9 percent.
   **This is a different kind of negative from the five above it.** Those were signals that did not
   exist. This is a signal that exists, scales exactly as the mechanism predicts, and is arbitraged to
   the fee line: in the deepest bucket the positive rate is 49.9% on a median of −0.03%, which is a fair
   coin priced at cost. The barrier is COST, not the absence of structure. Its left tail is the warning:
   median −0.03% sitting on a mean of −2.39%.

---

## 6B — WHERE THE MONEY ACTUALLY GOES, AND WHY THAT ANSWERS THE WHOLE QUESTION

Pure accounting over one 2.3-hour window, 550 WSOL-quoted pools, 21,345 trades priced from
reserve deltas rather than the defective quote fields. No return, no strategy, no outcome
variable. `scripts/money-flow.ts`, artifact `artifacts/money-flow.txt`.

Takers paid **146.6 SOL** in that window. It went:

| recipient | SOL | share | bps of volume | is there an offsetting loss? |
|---|---|---|---|---|
| coin creators | 77.45 | **52.8%** | 31.1 | **NO. No inventory, no LVR, no prediction.** |
| liquidity providers | 47.89 | 32.7% | 19.3 | **YES — MT112 measures rebalancing at ~8x fee income** |
| protocol | 21.21 | 14.5% | 8.5 | not a seat available to us |

**There are exactly three seats at this table.** The LP seat gives the money back and more.
The protocol seat is not for sale. The creator seat keeps what it takes — it is the only
structurally unhedged income on the venue, and it is the largest of the three.

**But it is a lottery, not a business we can enter.** Creator income is brutally concentrated:
**12 of 346 earning pools carry 80% of it.** The median earning pool makes **0.0076 SOL per
2.3 hours** — nothing. p99 is 3.61 SOL and the single top pool made 29.29 SOL on 3,109 SOL of
volume at ~94 bps. Winning that lottery requires *volume*, and volume follows attention. That
is a distribution problem, not a trading problem, and this system has no distribution.

A related fact that kills the obvious cost-selection idea: **zero-creator-fee pools carry 59.8%
of volume** (13 pools of the 84 with >=20 priced trades). The cheap pools are where the flow
already is, so cost selection buys no privileged access — it just puts you in the crowd.

**The synthesis.** Every durable line of income here is a toll on flow. We own neither the flow
nor the rails. That was written as a slogan on an earlier branch; these are the numbers under it.

CAVEATS THAT TRAVEL WITH THE TABLE: one window, one cluster. 179 of 792 pools (22.6%) were
REFUSED as unread rather than assumed WSOL, and 63 as non-WSOL. A first cut that skipped the
WSOL filter reported 21.8M SOL of volume in 2.3 hours — a quarter-billion SOL annualised —
because non-SOL quote mints carry different decimals; that is the same confusion CURRENT_STATE
already records producing a bogus 3,897 SOL sell, and it is why the filter is by name.

---

## 6C — THE COST FLOOR, MEASURED

`scripts/cost-census.ts`. The round trip identity, derived from the verified routing, is
**R = (q_eff+y)/(q_eff+x) · (1−f_total)²**, so a round trip costs **2·f_total and PRICE IMPACT
CANCELS** — you traverse the curve up and back. Our own impact at research size was never a
first-order cost, and `copy-fill.ts` charging the full ladder on both legs is CORRECT.

Round-trip cost across trades: **p05 50 bps, p50 60, p75 160, p95 240, max 250.** The creator
fee is the only large selectable term and is **zero on 65.7%** of trades. **23.1% of trades sit
at the 50 bps floor, across 74 pools — and every one of them is deep.** `cheap & shallow` is
again EMPTY, the same collinearity that produced the retracted cheap-fee finding.

---

## 6A — THE ONE SENTENCE THAT NOW SUMMARISES FIFTEEN MONTHS

**Three independent mechanisms, measured on 12 UTC day clusters of complete venue coverage,
all land on the same line: this venue is priced at its cost boundary.** Reversion exists and
scales exactly as impact theory predicts, and is arbitraged to the fee (MT110). Conditioning it
on depth separates catastrophic from break-even but never reaches profit (MT111). Providing
liquidity instead of taking it improves the fee-to-rebalancing ratio six-fold over MT100 and is
still 8 to 1 against (MT112). Every route ends at the same place, which is what an efficient
market at a high cost structure looks like from the inside.

**A FOURTH route, added after the first three.** MT114 swept the forward panel and found the
same line, plus one negative that replicates *hard*: **the more a pump.fun token has already
moved, the worse it does next.** At 10m→24h — flat −3.06%, up 2–20% −20.30%, above +20%
−48.87%; add depth over $5k and it is **−78.54% mean, −88.57% median, 6 of 6 days, fit −80.6%
/ holdout −70.0%.** This is the strongest-replicating effect the programme has ever measured
and it is **on the unshortable side** — there is no borrow for these tokens on this venue. The
one thing that clearly works cannot be traded here. That is worth stating plainly rather than
filing as another negative.

**What that implies for any future attempt.** The binding constraint is COST, not the absence of
structure. Costs here are protocol 5 bps and LP 20 bps, which nobody escapes; creator fee 0–95
bps, which is set per coin and IS selectable; price impact, which is set by depth relative to
size and IS selectable; and priority fees, which have never been measured in this programme. Any
serious proposal must either lower a cost we are currently paying or find an edge worth more
than roughly 50 bps a round trip in a deep pool. No edge measured in fifteen months has been.

---

## 7 — WHAT IS STILL OPEN

0. **~~MT111~~ — CLOSED, see §6.7. Retained here only because its by-product is the most useful
   fact the programme owns: depth. Kept for the successor, not as an open question.** MT110 established that reversion is real and
   cost-bound. On the fit day, splitting by pool DEPTH (which is what sets our own impact, while the
   reversion itself does not scale with it) gives **13 of 18 deep pools positive at a median +1.83%
   against 6 of 19 shallow at −1.72%**, with the POOL as the unit and overlapping events dropped. That
   is a sign test at p≈0.048 one-sided on ONE day, which is marginal and is the eleventh row in the
   ledger. The rule is frozen in absolute terms (5% impact bar, 15s horizon, 35 SOL cut) and declared
   OUTCOME-DRIVEN. It is being tested on **12 windows drawn from 12 distinct UTC days that were never
   queried**, which clears MT108's ten-cluster floor. Four conditions, any one of which closes it,
   including that the shallow control must NOT also pay. A survivor licenses paper mode and nothing else.
   Runner: `scripts/mt111-holdout.ts`.

1. **MT106 — LP on the deep, high-fee pools.** The only mechanism found that needs **no predictive
   edge, no latency, and no distribution**. MT100 killed LP on median-25-SOL pools at `lpFeeBps=2`;
   the wallet-traded population is median 108 SOL with `lp_fee_bps=20` on 71.7% of flagged buys —
   ten times the LP share. MT106 self-voided on my instrument (sparse sampling made the invariant
   method invalid: k shrank in 30.8% of 139,145 steps). **Fix is known**: dense per-pool coverage
   (the tape now does this for tracked pools) plus `DepositEvent`/`WithdrawEvent` decoding, which is
   decoded in `pumpswap-event.ts` but NOT wired: no table, never called by the collector, and never verified against a captured event. Calling it built was wrong.
2. **Sub-120-second horizons.** Every measurement this programme has ever made is ≥120 s. Phase C
   and the identity literature both say the signal lives at seconds. The tape can measure it and
   never has.
3. **A systematic conditional sweep over the whole venue.** We have every trade with buyer, size,
   reserves and fees. Only one conditioning variable has ever been tested (flagged-wallet buy).
   Requires a preregistered fit/holdout split — now affordable because history is free.
4. ~~**The forward panel.**~~ **EXHAUSTED — MT114.** ~216 cells swept. On the executable
   population (pump.fun, 93% of the panel) **all 48 cells are negative at BOTH a 50 bps and a
   250 bps floor, fit and holdout, 0 of 6 days positive.** Three structural defects shrink
   1.25M rows to almost nothing, and they are properties of the TABLE, not the market:
   **paired observations exist on only 6 UTC days, so it can NEVER clear MT108's ten-cluster
   floor whatever is asked of it**; the median forward return is *exactly* 0.00% in every
   unconditional cell because only 16–53% of consecutive priced pairs differ at all; and the
   means are single-observation artifacts — one of 66,011 observations is 65% of the sum in
   one cell and **114%** in another, and winsorising at p99 turns every unconditional mean
   negative. Decisively: **`price_usd` is a provider USD price, not an executable quote** —
   `route_exists` is non-null on 2,309 of 1,668,615 rows — so no cell here has ever been shown
   executable. The one strong cell found (+41.41% net, 6/6 days) was retracted by the same pass:
   the variable was launchpad not liquidity, censoring is 55–61% and forcing it to −100% flips
   the cell to −43%, and the mechanism is **a feed backfilling to a value it then freezes at**
   — 24.2% of those mints have a strictly monotone-rising path with not one down-tick.

---

## 8 — THE STANDING RULES (do not relax without a ledger row)

- Preregister in `docs/MULTIPLE_TESTING_LEDGER.csv` **before** the query runs. Every amendment gets
  its own row; the superseded row is left verbatim.
- Distinguish **availability/population-driven** changes from **outcome-driven** ones, explicitly.
- Rejections are stored with a reason, or the rule cannot be evaluated.
- An absence is never a zero. Fail closed.
- `bigint` for every token amount; TEXT in SQLite.
- Never widen a risk cap or weaken a gate to make something pass.
- Never run `canary`/`live`, never create the acknowledgement file, never read `.env`.
- Two instruments agreeing is evidence; one is a claim.
