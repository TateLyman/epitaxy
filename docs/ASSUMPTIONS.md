# Assumptions

Every assumption this system runs on, what would falsify it, and what happens when it
turns out to be false. An assumption not written here is one nobody is watching.

Last reviewed: 2026-08-11.

---

## About the data provider

**A1. Jupiter's keyless tier remains available and sufficient.**
The strategy is designed around roughly 30 requests per minute with no API key, because
the master constraint forbids a paid subscription as a hard dependency. This is why gates
are split into cheap (no quote) and expensive (round-trip quote) layers — a quote costs
two of the scarcest thing we have.
*Falsified by:* sustained 429s at a rate below the configured budget, or the keyless tier
being withdrawn.
*Consequence:* discovery throughput drops and the age window is missed. Not a correctness
failure — the system screens fewer tokens rather than screening them wrongly.

**A2. `organicScore` is not computed for tokens under roughly one hour old.**
Measured 2026-08-11 across 461 tokens in that age band: zero exceptions.
*Falsified by:* a non-zero score appearing on a young token.
*Consequence:* if it becomes populated, the soft-risk fallback stops firing and the hard
veto starts applying, which is the intended behaviour. No change needed, but the scoring
term's weight (see A9) becomes live and should be re-examined.

**A3. `devBalancePercentage` is absent for most tokens in the traded window.**
Measured 2026-08-11: absent for 81% of 3561 tokens.
*Falsified by:* the absence rate dropping materially.
*Consequence:* more tokens receive a real dev-balance verdict instead of a 0.2 soft-risk
term, and the eligible population changes. That is a strategy change and belongs in the
multiple-testing ledger.

**A4. Provider-reported liquidity is indicative, not executable.**
It counts pool reserves including bonding-curve virtual liquidity.
*Falsified by:* nothing — this is a known property, not a hypothesis.
*Consequence:* liquidity is never used to size a position. Only a round-trip quote is.

**A5. `topHoldersPercentage` counts the liquidity pool as a holder.**
For a pre-migration launchpad token this is most of the supply, so the figure cannot
distinguish "one whale owns it" from "it has not migrated yet".
*Consequence:* the provider figure is a soft pre-filter only. The authoritative
measurement is `getTokenLargestAccounts` on chain.

**A6. The provider's response reflects a recent view of the chain.**
*Falsified by:* indexer lag beyond `maxSourceAgeMs`.
*Consequence:* the `data_freshness` veto rejects the snapshot. Decisions are not made on
stale data; they are simply not made.

---

## About the strategy

**A7. There is an exploitable pattern in the 120s–3600s age window.**
This is the central unproven claim of the whole system. The window was chosen *a priori*
from a constraint — the master prompt forbids competing in a first-block latency race —
and not from data, which is the only way a window can be chosen without spending alpha.
*Falsified by:* a full paper-mode sample with realized net expectancy at or below a
buy-and-hold-SOL benchmark.
*Consequence:* the strategy does not work. No amount of threshold tuning fixes a window
with no edge in it, and tuning it after the fact would be the exact p-hacking the ledger
exists to prevent.

**A8. The soft-risk weights rank tokens usefully.**
Assigned by judgement. Still unvalidated, but no longer for want of any outcomes at all:
as of 2026-08-11 there are **10 closed positions, all simulated**. Ten is far below the
number at which a rank correlation means anything, so the assumption is untested rather
than supported.
*Falsified by:* no rank correlation between soft risk and realized return.
*Consequence:* scores are noise and sizing is arbitrary within the eligible set. Entry
would still be bounded by the risk caps, so this is a lost-opportunity failure rather than
a capital failure.

**A9. Each scoring term contributes something.**
Known false for one term: `organic` carries weight 0.20 and reads a field that is
structurally zero across the entire eligible age window (see A2). Twenty percent of the
score is currently a constant.
*Consequence:* recorded as MT004 in the multiple-testing ledger and left unchanged,
because reweighting is itself a hypothesis that needs its own row and its own sample.

**A10. The liquidity floor admits tradeable tokens and excludes untradeable ones.**
Chosen a priori. Never measured against round-trip cost.
*Status as of 2026-08-11:* the first paper outcomes are **evidence against this
assumption**. Of 10 closed simulated positions, **8 exited via `exit_cost_exploded`** —
`exits.ts:51` forcing a sale because exit price impact exceeded `maxExitImpactBps` (500).
That is not a directional loss; it is the position being unsellable at the size that was
entered. A floor doing its job would not admit tokens that cannot be exited.
*Falsified by:* a measurement showing round-trip loss does not degrade across the floor.
*Consequence:* this is the calibration most exposed to p-hacking, because it is the one
where moving a number visibly changes the eligible count. It must be set against measured
cost on a held-out period, never against realized returns — and specifically **not** by
raising `minLiquidityUsd` until these 8 exits stop appearing, which would be fitting the
threshold to the ten outcomes that motivated the change. See MT005.

---

## About execution

**A11. A quote obtained at decision time is executable shortly after.**
*Falsified by:* realized slippage systematically exceeding quoted slippage.
*Consequence:* the intent expiry refuses to sign a stale decision, so the failure mode is
a refused trade rather than a bad fill. Canary exists to measure the gap between modelled
and realized impact before any size is committed.

**A12. The chain is the only authority on whether a transaction happened.**
Provider acknowledgements are never treated as confirmation.
*Consequence:* recovery re-reads status from the chain, and a transaction whose fate is
unknown stays unknown rather than being guessed in either direction.

**A13. Jupiter v6 is the only swap program our transactions will invoke.**
Enforced by the program allowlist, not assumed.
*Falsified by:* the router legitimately needing another program.
*Consequence:* the transaction is refused. Fail closed — an unrecognised program is one
we have not reasoned about.

**A14. `MAX_KNOWN_EXTENSION = 28` covers the current Token-2022 extension set.**
*Falsified by:* a new extension discriminant shipping upstream.
*Consequence:* `decodeMint` refuses the mint rather than skipping the unknown entry. The
candidate is rejected until the decoder is updated. This is the correct direction to fail.

---

## About the environment

**A15. Node's `node:sqlite` is stable enough to hold the research corpus.**
It is marked experimental and emits a warning on every run.
*Falsified by:* an API change in a Node release, or corruption under load.
*Consequence:* the corpus is the one artifact that cannot be regenerated.

*Correction, 2026-08-11:* an earlier revision of this file said there was **no backup**.
That was wrong. `openDb` (`db.ts:335-342`) copies the database to `<path>.bak` on every
non-readonly open, and `data/runtime.db.bak` exists. But it is much weaker than a backup,
in three specific ways, and should not be relied on as one:

1. It copies the main file only. The database runs in **WAL** mode and the copy neither
   checkpoints first nor copies `runtime.db-wal`. Committed transactions still in the WAL
   are therefore absent from the copy, and a concurrent writer can tear it. Observed: the
   live file is 299 MB against a 181 MB `.bak`.
2. It is overwritten on every open, so the run that corrupts the database also destroys
   the last good copy before anyone notices.
3. The failure path is an **empty `catch`** whose comment claims "we surface it". Nothing
   is surfaced. A backup that silently does not happen is worse than none, because it is
   believed in.

Register row O017 is corrected from `designed_not_implemented` to `partial` on this basis.

**A16. Only one engine runs against the database.**
Enforced by `ProcessLock` comparing pid and heartbeat, not assumed.
*Note:* `pnpm reconcile` does **not** currently take the lock (O024). Running it against
a live engine is a real hazard today.

**A17. The host clock is correct.**
Every age and freshness gate is computed against `Date.now()`.
*Falsified by:* NTP drift, or a suspended and resumed host.
*Consequence:* **undetected.** There is no clock-skew check and no sleep/resume detector
(D015, O012). This is the most significant unguarded environmental assumption in the
system: a host that sleeps for an hour and wakes will compute every token's age as an hour
older than it was, and the age window will silently select a different population.

---

## Assumptions deliberately not made

- That a token's name, symbol, or metadata means anything. Display only.
- That a provider's absence of a field means the field's value is safe.
- That a previous run's in-memory state survived. Everything is rebuilt from storage or
  from the chain.
- That a test passing means the behaviour is right. Replay tests prove the checker catches
  tampering; chaos fixtures are confirmed to fail against a deliberately broken
  implementation.
