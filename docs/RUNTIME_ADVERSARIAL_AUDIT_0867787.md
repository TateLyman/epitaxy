# Runtime adversarial audit — head `0867787`

**Final state: `MEASUREMENT_REPAIR_REQUIRED`.**

An adversarial pass over my own implementation of the `29c7cc7` collector
directive, run on the operator's actual tree, actual runtime database, actual
WSL worker and a live read-only RPC.

Per the audit directive, **nothing is fixed in this commit.** The ledger lands
first; repairs follow separately.

## A — the machine

| | |
|---|---|
| local SHA | `0867787` (clean) |
| remote | identical, 0 unpushed |
| schema | v36 |
| database | `data/runtime.db`, live, node writers active |
| backup | `baseline-29c7cc7-2026-08-15T02-14-37-516Z.db`, 6,945,947,648 bytes, sha256 `8e359ca9…`, integrity ok, 0 FK violations |
| RPC | `magical-silent-cloud.solana-mainnet.quiknode.pro` — QuickNode **discover (free)** plan |
| WSL | Ubuntu-24.04, worker built and runnable |
| CI | green at `0867787` |

## B — is the named command real? **PARTIAL PASS, then FAIL**

`pnpm trajectory:collect --once --max-candidates=4 --max-open=3`

| requirement | verdict |
|---|---|
| opens a trajectory | **PASS** — 3 rows written in a prior run |
| writes current database rows | **PASS** — `development_trajectories`, append-only |
| continues to later marks | **FAIL** — no mark path is collected by the collector |
| settles a policy outcome | **FAIL** — 0 rows have settled |
| never imports signer/network-send | **PASS** — no `packages/execution` import |

So the command is no longer a discovery-only stub, and it is also not yet a
collector: it opens and stops. `development_trajectories` holds **3 rows, all
`AWAITING_FILL_OBSERVATION`, 0 settled**.

## F0 — THE BLOCKER, and my previous diagnosis was wrong

**`getMultipleAccounts` is capped at 5 accounts on this plan.**

```
HTTP 413
{"code":-32615,"message":"getMultipleAccounts is limited to a 5 range,
 upgrade from discover plan …"}
```

The coherent snapshot's economic batch is **six** accounts: pool, base vault,
quote vault, mint, fee config, Clock.

It broke the moment the F4 repair moved the Clock **into** that batch, taking it
from five to six. Every subsequent candidate refused `SNAPSHOT_INCOHERENT` with
an RPC error wearing a snapshot error's name.

**I previously reported this as provider throttling and asked the operator for a
second key on that basis.** The new key reproduces it exactly, which falsifies
the diagnosis. It was never rate-related: it is a hard per-call account cap, and
one extra account crossed it. The cost of that error was a request for
infrastructure that would not have helped.

Two further consequences worth stating:

- The whole point of the coherent snapshot is that every price-bearing account
  comes from **one** call, so a 5-account cap is a hard ceiling on the economic
  set, not a tuning parameter.
- `SNAPSHOT_INCOHERENT` swallowed an RPC transport failure. An apparatus failure
  reported as a market/coherence refusal is the substitution this repository
  exists to prevent, and it is present in code I wrote.

## The ledger

| § | invariant | verdict |
|---|---|---|
| A | machine established | **PASS** |
| B | named command opens + writes DB rows | **PASS** |
| B | named command marks + settles | **FAIL** — opens and stops |
| C | end-to-end trajectory trace with FK links | **FAIL** — no settled row exists to trace |
| D | direct-entry sole-venue attribution | **PASS** — base-vault delta must equal taker credit; enforced in `open-trajectory.ts`, 3/3 live rows attributed |
| D | routed/split entry rejected | **NOT TESTABLE** — no routed fixture exercised through the primary lane |
| E | build-once, no rebuild dependency | **PARTIAL** — bytes are built once and executed; the **fee recipient is not pinned or persisted**, so a differing selection on rebuild is undetected |
| F | u64 as decimal strings across NDJSON | **FAIL** — lamports/rentEpoch still cross as JSON numbers |
| F | `known` resets on Init | **FAIL** — not reset |
| F | job byte accounting resets on Init | **FAIL** — `bytesSeen` is process-lifetime |
| F | runtime instance ID changes | **FAIL** — none returned |
| F | 0.04 SOL job under output limit | **NOT TESTABLE** — blocked by F0 |
| G | quote-state equality breaks on mutation | **PASS** — per-account content hash; probe confirms |
| G | no successful trajectory carries unobserved required accounts | **PARTIAL** — recorded in `incompleteness`, not enforced as a refusal |
| H | cold / prewarmed / repeat surfaces | **FAIL** — not built |
| H | every created account classified by scope | **FAIL** — not built |
| I | cashback on BOTH legs | **FAIL** — SELL accumulator accounts still unmodelled |
| J | fee tier from SDK selection, not quote reserve | **FAIL** — `tierFor` still keys off quote reserve |
| K | each settlement component enters once | **PASS** — rent/failed/transfer-fee double-count repaired, tested |
| K | unexplained movement derived | **PASS** — reconciles named flows; first attempt was tautological and was replaced |
| L | append-only evidence | **PARTIAL** — duplicate trajectory ID refused; replacement settlement path untested |
| M | bounded vs full-replay counterfactual | **FAIL** — full replay not built |
| N | one shared path, all policies | **PASS** — `mark-path.ts`, tested |
| N | five policy counterexamples | **PARTIAL** — exit pair differs; three entry counterexamples not constructed here |
| O | Mayhem agent flow excluded | **NOT TESTABLE** — module exists, not wired to a decision |
| P | WSS vault subscriptions | **FAIL** — `vault-watch.ts` has no production importer |
| Q | commands mean their names | **PARTIAL** — several still share one generator |
| R | readiness reads one DB-stamped contract | **FAIL** — default still the old position gate |
| S | restart resumes open trajectories | **NOT TESTABLE** — no scheduler state persisted |
| S | real 1m/5m/15m marks in current context | **NOT TESTABLE** — blocked by F0 |

## Consequence

Six `NOT TESTABLE` production invariants and a majority of `FAIL`s.

By this directive's own rule — *a `NOT TESTABLE` production invariant prevents
state promotion* — no promotion is admissible. The state is
**`MEASUREMENT_REPAIR_REQUIRED`**, and would be even if every testable item had
passed.

The single highest-value repair is **F0**: without a snapshot the collector
cannot open, and without opening nothing downstream can be exercised at all.
