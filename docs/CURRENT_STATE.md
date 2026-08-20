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
2. **SQD Portal backfill.** `portal.sqd.dev/datasets/solana-mainnet/finalized-stream`, no key.
   Server-side Anchor discriminator filter works: **39,923 pump_amm buy/sell instructions in 4.15 MB
   in 0.7 s**. A month of history ≈ 2 hours of downloading, free.
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

---

## 7 — WHAT IS STILL OPEN

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
4. **The 626,449-row forward panel**, beyond the one cell that failed to replicate.

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
