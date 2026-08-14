# Offline LiteSVM parity, by fingerprint

`pnpm simulator:sequential-proof` · `pnpm simulator:true-stateful-proof`
→ `artifacts/sequential-runtime-proof.json`, `artifacts/true-stateful-roundtrip-proof.json`

## What the runtime is

`offline-worker/` — one Rust process per job, immutable job file in, immutable
result file out. `send_transaction` COMMITS, so step N+1 sees exactly what step N
produced: the same pool account, the same vaults, the same volume accumulator,
not re-read copies of them.

```rust
LiteSVM::new()
    .with_blockhash_check(false)   // these bytes carry a mainnet blockhash
    .with_sigverify(false)         // nothing in this system ever signs
    .with_transaction_history(0)   // every unsigned tx shares the zero signature
```

Each of those three is a real property of LiteSVM answering a question nobody
asked here, and each was found by a refusal rather than by reading. The third is
the interesting one: the runtime dedups on `signature()`, an unsigned
transaction carries the **zero** signature, so the second step of any sequence
was refused as `AlreadyProcessed` however different its content.

## Version

`litesvm = "=0.6.1"`, pinned and verified rather than assumed. 0.15.2 and 0.14.0
both fail to compile against their own resolved crate sets (`ExecutionRecord`
moved, the `Sysvar` bound changed).

## Program loading

From the **actual ELF**, via `add_program`. The previous version called
`set_account(executable = true)` and called that program loading; that populates
no program cache, and every route through such a program failed with an invalid
program error that read as a fact about the token.

An upgradeable program account holds a discriminant and a pointer. The ELF lives
in **ProgramData at offset 45**. And a program loaded by `add_program` must NOT
also be restored as account data — `set_account` replaces the program cache
entry with loader bytes, which surfaced as `Instruction(MissingAccount)` on
every venue program.

## Fingerprint coverage

| fingerprint | buy | sell | close | notes |
|---|---|---|---|---|
| PumpSwap canonical, Token-2022 base, WSOL quote | 0 bps | 0 bps | ok | 36/36 cells exact against the offline model |
| Jupiter-routed buy into a PumpSwap pool | ok | n/a | ok | the router's own bytes, replayed |
| plain SOL transfer (the sequencing control) | ok | ok | n/a | step 2's pre-state holds step 1's transfer |
| PumpSwap, legacy SPL base | not sampled | | | no legacy-base mint appeared in the sample |
| PumpSwap, USDC quote | not sampled | | | every canonical pool in the sample quotes WSOL |
| bonding curve, pre-migration | not run | | | no canonical pool exists before migration |

## Programs that must be loaded

Three, not one. A PumpSwap swap CPIs into the pump program for the volume
accumulator and into the fee program for the dynamic tier, and neither appears
as any instruction's program id:

```
pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA   the AMM
6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P   pump
pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ   fee program
```

Loading only the AMM produced anchor `3009` (`InvalidProgramExecutable`) at
whichever instruction index happened to reach one of the others first. Same
class as the Jupiter case: **a program invoked by CPI is named in no instruction
list**, so deriving the load set from `programIdIndex` finds only the entry
point.

## Lookup tables

A v0 message names its address lookup tables by address, and the runtime has to
read each table account to resolve anything through it. Capturing the addresses
*inside* the tables while omitting the tables themselves produced
`AddressLookupTableNotFound` on every routed buy — the accounts were all present
and the map to them was not.

## Known apparatus failures

Two of six mints attempted in the size surface failed entirely with
`InvalidProgramForExecution` and anchor `3012` (`AccountNotInitialized`). These
are recorded as `INSTRUMENT_*` rather than as market facts, and they mean the
sample is "the mints the apparatus can simulate" — a selection effect that is
possible and unmeasured.
