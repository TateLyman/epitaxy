<!--
  RECEIVED 2026-08-19 as 7a8d7564-epitaxy_deep_research_prompt.pdf, immediately after PR #65
  merged.

  THIS IS A TRANSCRIPTION, NOT THE ORIGINAL BYTES. The source is a PDF and this repository's
  convention for PDF directives is to transcribe faithfully and mark what the PDF lost rather
  than to reconstruct it. Three losses are marked inline with [PDF LOST: ...]. Two are single
  glyphs (an alpha and an arrow) whose identity the surrounding text fixes beyond doubt but
  which are marked anyway; the third is a two-column layout artifact in the "For every
  mechanism reported, state:" list, where a nine-item list and a floating fragment
  "yes / no / conditionally" were emitted as separate text runs and their intended pairing is
  not recoverable from the extraction. Both readings are preserved rather than one being
  chosen. The extractor's glyph substitutions for em-dashes, en-dashes and list bullets have
  been restored to their evident intent, and nothing else has been reworded, reordered or
  summarised.

  This directive differs in kind from A through H. It commissions no measurement on the local
  corpus and preregisters no decision rule, so no MULTIPLE_TESTING_LEDGER row was written for
  it; it is a literature-and-primary-source review with its own stated standard of evidence in
  the section so titled. Nothing in it authorises a mode change, a gate change, a funded
  wallet or a signature, and none occurred.

  The original PDF is at
  C:\Users\lyman\.claude\uploads\c257a710-620c-44df-97b1-550f4354341c\7a8d7564-epitaxy_deep_research_prompt.pdf

  Execution record: docs/FEE_ON_FLOW_RESEARCH_REPORT.md.
-->

# RESEARCH BRIEF — WHERE MONEY IS ACTUALLY MADE IN THE SOLANA LAUNCHPAD ECOSYSTEM

## Who is asking and what they have

A solo operator running a Solana memecoin research system. Fifteen months of infrastructure,
no capital ever deployed, nothing signed, no wallet funded. Assets on hand:

- A TypeScript measurement apparatus: cost model, PumpSwap fee-tier decoder, executable-quote
  pipeline, day-clustered bootstrap, preregistered decision rules, a multiple-testing ledger
  with ~98 entries, 2,200 tests.
- Dune Analytics access, ~500 credits remaining of 2,500, plus the ability to buy more.
- Local compute. No co-located infrastructure, no Jito relationship, no Yellowstone gRPC, no
  archival node.
- Deep familiarity with `dex_solana.trades`, `tokens_solana.transfers`,
  `pumpdotfun_solana.pump_evt_tradeevent`, and PumpSwap's on-chain `FeeConfig`.

Constraints that are fixed and not up for optimisation: US jurisdiction; no capital to lose;
solo; will not compete on latency infrastructure.

## What nine phases of measurement have already ruled out

Do not re-derive any of this. It is settled, with intervals, on 30-day out-of-sample windows.

1. **Token screening on features.** 720 preregistered cells, 360 tradable, zero decidable on
   point estimate or holdout lower bound, where ~13.5 false positives were expected at
   [PDF LOST: a single glyph before "=0.05" did not survive extraction; the surviving text
   reads "at =0.05"] =0.05. Median tradable cell −57.9%.

2. **Fee-tier conditioning.** The tier ladder is real and worth up to 165 bps, but the mean is
   negative everywhere the apparatus can trade.

3. **Copy trading, three separate estimands.** Wallet skill genuinely persists — top decile
   beats the rest by +36.47% [+33.38%, +39.84%] out of sample, 30/30 days, holding at entity
   level after stitching rotated wallets. It is not transferable: the follower penalty is
   +16.83% [+12.87%, +21.86%] per position, and mirroring the exit proportionally rather than
   binary is worth under one point and is negative on the largest arm.

4. **The post-migration AMM is efficient with a toll.** 455 executable-quote trajectories:
   median position at 60 minutes is worth −2.7%, against a measured round-trip cost floor of
   2.669%. The price does not move and the fee is the entire result.

5. **Curve entry is blocked and contested.** Quote-to-land slippage at a 2-second lag is
   +86.13% on the bonding curve against +0.03% median on the AMM. The competitive baseline is
   Yellowstone gRPC + Jito BAM + pre-signed transactions at slot 0.

6. **The one large positive figure was an artifact.** A +234% to +394% "pre-migration" mean
   decomposed into +193.10% venue mix against −4.29% within venue, over 57 mints with three
   carrying 54.69% of absolute return, at 90–97% censoring, and turned out to be direct
   Token-2022 mints on FluxBeam rather than bonding-curve tokens at all.

## Market context, to be verified rather than assumed

Weekly Solana DEX volume fell ~62% in three weeks in early 2026 ($118.2B [PDF LOST: a single
glyph between the two figures did not survive extraction; the surviving text reads "$118.2B
$44.5B"] $44.5B). pump.fun's seven-day graduation rate fell to ~0.26% by June 2026. Solana
daily network fees fell from ~33,000 SOL to ~5,300 SOL. Speculative capital rotated toward
perpetual-futures venues.

Verify these figures against primary sources. They come from trade press and vendor blogs.

## THE QUESTION

Every phase above measured whether taking a position makes money. The answer was consistently
no. But the ecosystem demonstrably produces large, durable revenue for someone:

| | |
|---|---|
| pump.fun | $124.7M in Q1 2026, ~36% of all Solana app revenue |
| Axiom (terminal) | $200M cumulative revenue in 202 days |
| Trojan (bot) | $21.4B lifetime volume at ~1% fee |
| creators | $2.1M distributed in 24 hours under Project Ascend; 0.95% of every trade for tokens under ~$300k market cap |

None of those is a directional trade. Each is a fee on flow.

So: **what are all the mechanisms by which money is actually and durably extracted from this
ecosystem, and which of them are accessible to the operator described above?**

Go in assuming at least one accessible mechanism exists and search hard enough to find it.
Report honestly if the evidence says otherwise — a well-evidenced null is a real answer and is
preferred to a weakly-evidenced yes.

## SPECIFIC HYPOTHESES TO INVESTIGATE

Investigate each. For each, the deliverable is: does the mechanism work, what are the actual
numbers, what capital and infrastructure does it require, what is its capacity, and what would
have to be true for a solo operator to run it.

### H1 — Liquidity provision on post-migration pools

Why this is the strongest position-based hypothesis and has never been tested. The apparatus
measured that the median tradable position's price does not move over 60 minutes. Zero drift
plus high turnover is the textbook condition under which market making is profitable —
impermanent loss requires drift, and the measured median drift is approximately nil.
PumpSwap's base fee is 0.25% with 0.20% to liquidity providers: the LP earns what the taker
currently pays.

The obvious objection is that the return distribution is not symmetric — median zero, tail
−100% when a token dies. So the question is not IL, it is total loss, and whether pool
selection, sizing, or exit rules can survive it.

Find: actual realised LP returns on PumpSwap and comparable pools, decomposed into fees earned
versus impermanent loss versus total loss. Any published dataset, dashboard, or study. What
fraction of memecoin LP positions are net positive and over what horizon. Whether anyone runs
this systematically and what their numbers look like.

### H2 — Creator-side economics

Project Ascend pays 0.95% of every trade for tokens under ~$300k market cap. Find the actual
distribution of creator earnings, not the headline totals: median, quartiles, what fraction of
creators earn more than trivial amounts, how concentrated the top is, and how much of the
reported $2.1M/day was a launch-week spike versus a steady state.

Distinguish carefully between two different activities: creators who build an audience and
earn fees from genuine trading interest, versus structures where the creator holds most of the
supply and the earnings come from retail buyers who lose. Report the economics of both, and be
explicit about which is which. The operator wants to know what is durable and legitimate, not
merely what is lucrative.

### H3 — Cross-venue arbitrage

The same token frequently trades on PumpSwap, Raydium, Meteora, Orca and FluxBeam
simultaneously. Find: documented spread sizes, how long they persist, who captures them, what
latency is actually required (as opposed to the slot-0 race, which is a different problem), and
whether any of it survives the 2.5% round-trip cost floor.

### H4 — Solana MEV

Entirely unexamined by this operator. Cover backrunning, sandwiching, JIT liquidity, and
liquidation. Find real revenue figures, the infrastructure genuinely required, whether Jito's
architecture makes any of it accessible without a validator relationship, and what the honest
floor on capital and setup is. Include the ethical and reputational picture — sandwiching
extracts directly from other traders and several venues actively fight it.

### H5 — Selling detection rather than trading on it

The operator has a working Token-2022 extension decoder, a fee-tier decoder, an executable cost
model, and a rug/honeypot signal. Rug detection, bundle detection, and wallet analytics are
existing product categories. Find: who sells these, what they charge, what the market size
looks like, whether it is saturated, and what a solo entrant's realistic path is.

### H6 — Referral, affiliate, and rebate structures

Trading bots pay referral fees. Terminals have affiliate programmes. Some venues offer maker
rebates or volume cashback. Find the actual rates, terms, and what volume is needed for these
to matter.

### H7 — Anything the above misses

Search deliberately for mechanisms not on this list. Interviews, post-mortems, forum threads,
research papers, court filings, and on-chain analyses where someone documents a repeatable
profit mechanism with real numbers. Include mechanisms that turned out to be frauds, and say
so — knowing what the profitable-looking-but-fraudulent structures are is directly useful.

## STANDARD OF EVIDENCE

This operator's own work runs on preregistered decision rules and day-clustered bootstrap
intervals, and has falsified its own hypotheses nine times. Match that standard.

**Strongly prefer:** on-chain data, Dune dashboards with visible queries, academic papers, SEC
or DOJ filings, protocol documentation, and revenue figures from Messari, DefiLlama or Token
Terminal.

**Treat as weak and label as such:** vendor blogs (RPC providers and bot vendors have obvious
incentives), affiliate-driven "best bot" listicles, YouTube and Twitter claims of returns,
anything with a referral link.

For every mechanism reported, state:

<!--
  [PDF LOST: layout artifact. The extractor emitted the nine list items below as one text run
  and the fragment "yes / no / conditionally" as a separate run. Under -layout the fragment
  sits on the same line as the first item; under the default extraction it trails the whole
  list. Its intended attachment is therefore not recoverable from the file. The two readings
  the text admits are (a) the fragment annotates the first item, and (b) the fragment is a
  tenth item, "does the mechanism work — yes / no / conditionally", matching the wording of
  the deliverable sentence that opens SPECIFIC HYPOTHESES TO INVESTIGATE. Both are preserved
  below; neither has been chosen.]
-->

- the mechanism, mechanically, in one paragraph — *[floating fragment: `yes / no / conditionally`]*
- who is documented to run it, with a source
- realistic revenue, with the source and date
- capital required to start
- infrastructure required
- capacity — the size at which returns degrade
- what kills it — the specific failure mode
- accessible to a solo US operator with no deployed capital?
- confidence, and what evidence would change it

Where the honest answer is "no reliable public data exists," say that rather than filling the
gap with plausible reasoning. A stated unknown is more useful here than an estimate, because
this operator's entire method is built on refusing to price the unmeasured.

## FINALLY

Rank every mechanism found by expected value for this specific operator given the constraints
at the top — solo, US, no deployed capital, no latency infrastructure, strong measurement and
research capability, willing to build software.

If the honest ranked list is short, or if the top entries are all inaccessible, say so plainly
and explain what specifically blocks each. That outcome is a legitimate finding and it should
be reported as clearly as a positive one would be.
