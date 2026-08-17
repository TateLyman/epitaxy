# Clean window runbook

How to open a development evidence window that produces trajectories whose
economics can be independently recomputed — and how to tell, before starting,
whether you are allowed to.

## Before anything

```bash
pnpm collector:list          # must report ZERO
pnpm collector:stop-all      # if it does not
git status --short           # must be EMPTY
pnpm check                   # typecheck + secretscan + 1867 tests
```

A dirty tree is refused. `--instrument-development` permits it and writes to a
context that is **permanently** excluded from evidence — quarantine, not
permission.

## 1. Back up

```bash
pnpm db:vacuum-backup
```

Refuses while a trajectory collector is alive, and refuses under 20 GB free.
`sqlite3_backup_step` restarts from page zero whenever the source is written and
never converged on this corpus; `VACUUM INTO` takes one read transaction. The
backup is read back and verified: sha256, bytes, per-table counts, schema
version, integrity, foreign keys, nonterminal exposure.

Last verified backup:

```
data/backups/vacuum-2026-08-17T03-15-49-203Z.db
7,155,707,904 bytes
sha256 97de15dd3717798baf1d466285a211f5e9a54b7fcb0fc3e212e2b1c75d737e55
integrity ok, 0 foreign-key violations, schema v46, 0 exposed positions
```

## 2. Close the old window, if it is not closed

```bash
pnpm evidence:invalidate-old              # dry run: re-measures every reason
pnpm evidence:invalidate-old -- --apply
```

It **re-measures** all eleven reasons against the live corpus rather than copying
them from a document, and refuses to invalidate a corpus that measures clean.

## 3. Freeze the contract

```bash
pnpm contract:freeze -- --apply --cohort=FIRST_HOUR --notional=20000000
```

Freezes the source commit, cohort, notional rule, both policy sets, the mark SLA,
the counterfactual contract, the cashback and Mayhem treatments, the cost/rent
treatment, the risk facts, the thresholds and — importantly — the list of audit
invariants this window **claims**.

An invariant deliberately out of scope is removed here with its reason, and is
then not claimed anywhere else either. Carrying one as "NOT TESTABLE but promoted
anyway" is what this replaces.

## 4. Pass the acceptance gate

```bash
pnpm gate
```

Required, over the invariants the contract claims:

```
FAIL         = 0
NOT TESTABLE = 0
```

`pnpm gate` performs every step the ledger needs — the VACUUM copy, the worker
probe, the command sweep, the seed sweep — because a manual step is how a probe
gets skipped, and a skipped probe is indistinguishable from a defect in the
tally.

## 5. Start exactly one collector

```bash
pnpm trajectory:collect -- --interval=300 --max-open=3 --max-per-mint=3 \
  --contract=<contract-id>
```

Then verify:

```bash
pnpm collector:lock-status   # exits non-zero unless ONE owner holds the lock
pnpm scheduler:status        # marks due, overdue, next deadline
```

Marks run on a 3-second tick against a 10-second SLA; discovery keeps its 300
seconds and is **deferred** whenever a mark is already past its SLA. Opening
another trajectory while deadlines slip trades a measurement already committed to
for one that is not.

## 6. Let the horizons happen

```
1m  3m  5m  10m  15m  30m  60m
```

**Do not backfill.** A late mark is `MISSED_HORIZON` and is excluded from the
sample. A backfilled horizon carries the right label on the wrong instant, which
collapses every horizon onto one moment and makes both exit policies agree
trivially — the audit measured 697 of 1,448 marks more than 60 seconds late, and
that is why the tournament could not distinguish the policies it exists to
compare.

## 7. Verify the ten

```bash
pnpm evidence:graph-check --strict
pnpm evidence:blob-check
pnpm trajectory:trace -- --all --limit=10
pnpm scheduler:status
pnpm policy:treatments-status
pnpm readiness
```

The milestone:

```
10 completed development trajectories
10 distinct or broadly spread mints
all links resolve
all raw evidence readable
all PnL independently recomputes
unexplained = 0
no unobserved writable
mark SLA held
actual entry-policy decisions stored
both exit policies evaluated on shared paths
```

Only then is `VALID_RECOMPUTABLE_TRAJECTORIES_RUNNING` true.

---

## Current blocker: RPC capacity

**The window cannot open trajectories today.** Measured 2026-08-17T04:50Z:

```
primary   dimensional-cosmological-sheet.solana-mainnet.quiknode.pro
          HTTP 429 "daily request limit reached - upgrade your account"
fallback  mainnet.helius-rpc.com
          HTTP 429 "max usage reached"
public    api.mainnet-beta.solana.com
          getSlot, getAccountInfo, getMultipleAccounts, getTokenSupply,
          getSignaturesForAddress all HTTP 200
          getTokenLargestAccounts  HTTP 429, 0 of 8 attempts at 5s spacing
```

`getTokenLargestAccounts` is the call the concentration gate needs. Without it
`admitCandidate` refuses with *"neither entity-adjusted nor raw concentration
could be read"* — which is **correct fail-closed behaviour** and must not be
weakened. The endpoint is the blocker, not the gate.

A repaired `--once` pass on 2026-08-17 confirmed the rest of the path runs: the
lock was taken, the provenance gate passed, marks were taken with SLA verdicts,
and the pass settled cleanly. It opened zero trajectories, for the reason above
plus a depth gate refusing candidates at 20.1 %, 75.3 % and 568.1 % of their
pool's effective quote reserve — the deep pools in the candidate queue have
already reached their per-mint cap.

Per P16, the smallest purchase that removes it is **Helius Developer**
(approximately $49/month, 10M credits, 50 RPC requests/second — use the dashboard
price as source of truth). That is a human purchasing act. Do not put the key in
logs, chat or Git.

Measured load, over **active collector seconds** rather than wall time:

```
104,852 calls over 19.6 active hours
1.49 calls per active second
48 quota refusals
```

Jupiter Developer is **not** recommended: direct PumpSwap is the primary lane and
Free's 1 RPS has not been shown to limit completed trajectories. No Shreds, no
dedicated validator, no colocation, no archival node before a positive untouched
edge exists.
