# P13 and P20 — what blocks them, exactly

Both are stopped by a specific, checkable thing rather than by judgement. Each
is recorded with what was verified, what is missing, and what closes it.

## P13 — current official Pump/PumpSwap model and parity

### Verified

The directive names two packages "approximately" at the audited date. Checked
against the npm registry on 2026-08-13:

```
@pump-fun/pump-sdk       1.36.0     matches
@pump-fun/pump-swap-sdk  1.19.0     matches
```

Neither is installed in this repository.

### Not done, and why not partially

P13's acceptance bar is parity:

> For each supported fingerprint compare: Epitaxy local quote, official SDK,
> current Jupiter BUILD_CUSTOM, settled on-chain swap. Require exact or fully
> explained deterministic difference. **A 123–257 bps residual is not parity.**

That bar cannot be met by writing the arithmetic from memory. Reaching it needs
the canonical-pool PDA and index, base/quote orientation, both vaults, the raw
base reserve, the effective quote reserve
(`raw quote vault + virtual_quote_reserves`), `is_mayhem_mode`,
`is_cashback_coin`, the dynamic fee tier with its LP/protocol/creator/buyback
components, the current disable/config state, and exact integer rounding —
each read from the live program account layout and each verified, not recalled.

Writing a plausible fee model and calling it parity is the precise failure this
directive exists to eliminate. A local quoter that is 200 bps wrong is worse
than none: it is wrong with authority, and it would be used for marks.

The directive is also explicit that a direct builder is **not enabled by
confidence alone**, and that BUILD_CUSTOM remains the decision-bearing path
until a direct builder passes the same policy, effect and parity tests. So the
cost of not having P13 is bounded: it costs route complexity, compute, latency
and offline-replay surface — none of which is on the critical path to a valid
label.

### What closes it

1. `pnpm add -E @pump-fun/pump-sdk@1.36.0 @pump-fun/pump-swap-sdk@1.19.0`,
   with the lockfile hashes pinned and recorded in `docs/SOURCE_MATRIX.csv`.
2. The account model read from the live programs and checked against the SDK's
   own decoders, not against this file.
3. A parity harness over settled on-chain swaps per fingerprint, requiring
   exact or fully explained deterministic difference.

That is a session of its own, and it is downstream of having a valid label to
mark.

## P20 — offline Rust/LiteSVM worker

### Verified

```
cargo   not found on Windows
cargo   not found in WSL Ubuntu-24.04
rustc   not found in either
```

There is no Rust toolchain on this machine.

### Not done, and why not partially

The deliverable is a pinned isolated worker whose results are **byte-comparable**
to the JIT path:

> 10 stateful buys, 10 stateful sells, multiple mints, legacy + Token-2022,
> amounts >2^53, same economic deltas, same fee/rent semantics, same
> created/closed accounts, same success/error, compute difference within a
> frozen tolerance.

Installing a toolchain is the smallest part. A worker that runs and produces
*nearly* the same numbers would be admitted to the confirmatory allowlist on
the strength of looking finished, and the directive is explicit that only
reviewed fingerprints enter it and that there is no global parity boolean.

The existing blocker it would solve is real and unchanged: Surfpool's
`surfnet_writeProgram` drops its RPC on the 10.5 MB Pump program, and the
`.so`-path theory was already falsified (`docs/OFFLINE_REPLAY_BLOCKER.md`).
Stable-pair offline replay works; Pump offline replay does not.

### What closes it

1. A Rust toolchain (`rustup`), pinned.
2. A LiteSVM worker: immutable job file in, immutable result file out, exact
   account and program state, all post-state accessible, hard CPU/memory/time
   limits, one process per job, runtime identity and binary hash persisted.
3. Per-fingerprint comparison against the JIT path on the criteria above.

## Consequence for the terminal state

Neither blocks `VALID_EFFECT_LABELS_RUNNING`, which requires the running paper
engine to produce stateful labels. Both block `CANARY_READY`, which requires
offline replay parity — so `CANARY_READY` is unreachable from here regardless
of how the strategy performs, and that is the correct ordering.
