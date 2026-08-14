# The trajectory kernel

`packages/pipeline/src/trajectory-kernel.ts` · `pnpm trajectory:kernel-proof`
→ `artifacts/trajectory-kernel-proof.json`

## What it owns

One production-importable object owns the whole economic lifecycle: candidate
snapshot, state capture, builder selection, sequential mechanics, entry
settlement, mark stream, trigger, later fill, exit settlement, cashback,
residual and rent, policy evaluation, persistence.

The process shell owns startup, dependency construction, scheduling, health and
shutdown — and nothing else.

Before this, the lifecycle lived inside `paper.ts` as a sequence of steps that
each re-derived what the previous one already knew. That is how one row came to
hold two entry costs, and how a fill could verify one observation and book
another.

## The immutable economic identity

Created once, at `open`, and carried through `observeMark`, `advance` and
`settle` unchanged:

```
trajectoryId · entryObservationId · entrySimulationJobId · entrySettlementId
venue · pool · capabilityFingerprint · snapshotHash · mint · cohort
migrationAge · notional · entryPolicyInputs · stratum
```

`assertSameIdentity` **throws** rather than returning false. A substituted
identity is not recoverable: a different observation is a different economic
event and needs a new identity. The proof confirms every bound field refuses
substitution.

## The four methods

**`open`** decides the evidence ceiling. A trajectory whose entry moves the pool
beyond the frozen 50 bps small-impact bound can never be
`BOUNDED_COUNTERFACTUAL`, however well it is measured afterwards, because the
future state it would be evaluated against never contained the entry. **Deciding
this at report time is how a weak trajectory becomes a strong one once the number
looks good.**

**`observeMark`** rejects an unpriced mark, a zero mark, and a mark that reuses
the entry observation — which would make entry and exit the same economic event.

**`advance`** selects a later fill. The ordering is the whole point and it is the
one the previous build got wrong:

```
observed → simulated → effect-verified → settled → THEN selected and booked
```

The first eligible candidate past the latency floor is taken, and its **own**
settlement is returned. `select A, simulate B, book A` cannot be expressed. The
proof includes the directive's scenario — A fails, B is valid, C is better — and
confirms B is booked and C is not, because taking the best would be hindsight.

**`settle`** builds one `TrajectorySettlement` and applies the entry-impact
haircut only to `BOUNDED_COUNTERFACTUAL` evidence. A landed fill needs no
haircut: the entry's effect is already in the price it got.

## Deliberately synchronous and stateless per call

Every input is passed in, so the kernel can be exercised with no database, no
network and no clock. The shell does the I/O; the kernel decides the economics.
That is what makes `trajectory-kernel-proof` able to ask whether the kernel can
be made to violate its invariants — a question a live run cannot answer, because
a live run only exercises the paths it happens to take.

## Proof results

```
identity substitution refused on every bound field   true
evidence ceiling decided at open                     true
selected observation == booked observation           true  (B, not C)
a claim cannot exceed its evidence                   true
```
