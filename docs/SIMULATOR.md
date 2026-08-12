# The simulator

## Why it exists

Paper mode cannot book a fill without one, and that is not a configuration
choice.

A mainnet `simulateTransaction` cannot validate either leg of a paper trade. The
paper taker holds no SOL, so a buy fails on funding. It holds none of the
hypothetical tokens, so a sell fails on balance. Both failures describe the
wallet, not the route, and reporting either as evidence about a token would be
worse than reporting nothing.

A local SVM removes exactly that obstacle and nothing else. It lets us give the
taker the balance the paper position assumes, then ask whether the exact
assembled bytes would execute. It does not make the route real, does not prove
the transaction would land, and is not evidence of edge.

## What was verified, and how

Not from documentation. Measured on WSL2 Ubuntu 24.04, 2026-08-12:

| check | result |
|---|---|
| package | `@solana/surfpool@1.5.0` |
| prebuilt binaries | `darwin-x64`, `darwin-arm64`, `linux-x64-gnu` — **no Windows build** |
| `Surfnet.start()` | boots a live RPC in **55–102 ms** |
| `getVersion` | `solana-core 4.1.2`, `feature-set 3345198602`, `surfnet 1.5.0` |
| `simulateTransaction` | reachable; correctly rejects malformed input |
| `fundSol` | payer balance moved 10 SOL → 7 SOL on demand |
| default network mode | **offline** — a mainnet USDC mint read back `null` |

That last row is the one that matters for evidence. An offline instance sees
exactly the accounts we put into it, which is what makes a run repeatable.

## Platform

There is no Windows-native build, so the simulator runs under WSL or Linux CI.
This machine already had WSL2 with Ubuntu 24.04 running, so no reboot or
elevation was needed.

```bash
pnpm simulator:doctor
```

reports the platform, whether a real SVM is available, the WSL distributions it
can see, and — separately — whether anything produced here could be
confirmatory. On Windows it exits non-zero and says where to run it.

A Linux checkout lives at `~/epitaxy` inside WSL with its own `node_modules`,
because the Windows tree's native binaries cannot load under Linux.

## Interface

`packages/simulator/src/types.ts` defines `Simulator` without reference to
Surfpool, so the implementation can be replaced without touching a caller.

```
start(snapshot)      fundSol      setTokenBalance    setAccount
simulate(bytes)      capturePostState                stop
```

Two implementations:

**`SurfpoolSimulator`** drives a real SVM over the instance's own JSON-RPC.
`isAuthoritative` is true. It executes.

**`DeterministicFixtureSimulator`** replays recorded outcomes keyed by
transaction bytes. It exists so CI and replay never depend on mainnet
availability or on a native binary downloading. `isAuthoritative` is false.

## The boundary that matters

A fixture must never be mistaken for evidence, and the enforcement is a field
rather than a convention:

```ts
isConfirmatorySimulation(r) =
  r.verdict === 'SIMULATED_OK' && r.simulator.isAuthoritative && r.snapshotHash !== null
```

Three tests hold that line:

- a passing **fixture** result is not confirmatory, whatever else it satisfies;
- an authoritative pass **without a frozen account snapshot** is not
  confirmatory, because just-in-time mainnet fetching is not reproducible — the
  same transaction against a moving chain is two experiments;
- an unrecorded transaction returns `SIMULATOR_UNAVAILABLE`, never a pass. A
  fixture that invented a result for an input it had never seen would be the
  most dangerous object in this repository.

## Account snapshots

`snapshotManifestHash()` is content-addressed over sorted
`(pubkey, slot, owner, lamports, executable, data)` tuples. Two properties are
deliberate:

- the same accounts hash identically however they were gathered;
- **the same account at a different slot is different evidence**, so the slot is
  inside the hash.

`buildSnapshot()` records `hasSlotDrift` when any account was read at a slot
other than the `/build` context slot. Drift is recorded, not smoothed: a
later-state simulation may legitimately model decision latency, but it may not
be called same-slot truth.

## What is NOT done

- **No parity corpus.** §6.7 requires replaying successful historical
  Jupiter/PumpSwap transactions and comparing deltas, logs, created and closed
  accounts, and units consumed. Until that exists this is development tooling,
  not evidence. `docs/SIMULATOR_PARITY.md` does not exist yet.
- **No exact transaction assembly.** §5 requires building the real v0 bytes from
  the `/build` response, resolving lookup tables, and running the strict
  byte-level policy. The current policy reasons about instructions and estimates
  a packet size. Nothing can be simulated until the bytes exist.
- **No two-pass compute calibration** (§6.5), no effect verification (§6.6), no
  account capture pipeline (§6.3).
- **The engine does not call it.** `requireLocalSimulation` remains true and
  every entry is still refused.

The simulator is built and proven to run. It is not yet wired to anything, and
until §5 produces exact bytes there is nothing coherent to hand it.
