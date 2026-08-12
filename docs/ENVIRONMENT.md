# ENVIRONMENT

The machine this system was built on and is expected to run on, and which of
its properties the design actually depends on.

All figures below were measured on the host, not recalled. Measurement date is
given per section because some of these numbers decay.

## Host

Measured `2026-08-12T00:20Z`.

| Property | Value |
| --- | --- |
| OS | Windows 11 Pro, build 10.0.26200 |
| Arch | x64 |
| CPU | AMD Ryzen 7 7800X3D, 8 cores / 16 threads |
| RAM | 31.1 GB total |
| Disk | 1.9 TB, 930 GB free |
| Timezone | America/Los_Angeles |
| Node | v24.12.0 |
| pnpm | 11.13.0 |
| Shell | bash (Git for Windows) |

Free memory at the time of measurement was **0.2 GB**. That is not a spare
figure. The system tolerates it because its working set is small and SQLite is
memory-mapped rather than buffered in the process, but a host this close to its
ceiling will page, and paging a WAL write is how a "fast" local database becomes
a 200 ms one. Anything that must be timed — and the freshness accounting is
timed — should be read with that in mind.

## Why Node 24 specifically

`packages/storage/src/db.ts` imports `DatabaseSync` from `node:sqlite`. That
module is built into Node and requires no native compilation step, which on
Windows removes a genuine fragility source: a native SQLite addon needs a
working MSVC toolchain, and its build output is a favourite false positive for
antivirus. Removing the addon removes both problems.

The cost is a hard floor. `node:sqlite` is not available before Node 22 and is
still flagged experimental in 24 — every run prints:

```
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

`package.json` declares `"engines": { "node": ">=24.0.0" }`. This is not
aspirational; on an older runtime the storage layer does not import.

### The one place this leaks into tooling

Vite's builtin-module check strips the `node:` prefix before looking a name up.
Node exports this module **only** as `node:sqlite` — the bare name `sqlite` does
not exist in `builtinModules`:

```
> require('module').builtinModules.filter(x => x.includes('sqlite'))
[ 'node:sqlite' ]
```

So Vite concludes it is not a builtin, strips the prefix, and tries to resolve a
package called `sqlite`, which fails. `vitest.config.ts` carries a small plugin
that intercepts the id and hands the module back to Node's own loader through
`createRequire`. Without it, every test that touches storage fails to collect —
not fails, *fails to collect*, which is worse, because a suite that never ran
looks nothing like a suite that ran and passed unless you read the file count.

## Runtime model

TypeScript is executed directly by `tsx`; there is no build step and no `dist/`.
Imports are relative and carry the `.js` suffix required by ESM resolution even
though the files on disk are `.ts`.

The practical consequence: **`pnpm typecheck` is not implied by anything else.**
Nothing in the run path type-checks, so a type error ships silently until
`tsc -p tsconfig.json --noEmit` is run. `pnpm check` chains typecheck, secretscan
and the test suite for that reason, and is the only command that establishes the
repository is sound.

## Storage

One SQLite database, `./data/runtime.db` by default (`DATABASE_PATH` overrides),
in WAL mode with `synchronous = NORMAL`, `foreign_keys = ON` and a 5 s busy
timeout.

WAL permits concurrent readers alongside one writer, which is what makes
`pnpm status` and `pnpm health` safe to run against a live paper session. It
does **not** permit two writers, and two engines writing the same balance is a
catastrophic failure rather than a slow one. That is enforced by the
`process_locks` table and the `ProcessLock` class, not by convention.

A live example, read from the database at `2026-08-12T00:21Z`:

```json
{"lock_name":"engine","pid":19816,"hostname":"TATE",
 "acquired_utc_ms":1786488758389,"heartbeat_utc_ms":1786494105977,"mode":"paper"}
```

A heartbeat 1.6 seconds old, held for 89 minutes. A second engine started now
would find that lock fresh and refuse. A lock older than the staleness window is
treated as abandoned and may be taken — that window is the only thing standing
between a crashed process and a stuck system, and it is why the value is a
constructor parameter rather than a literal buried in a method.

## Network

The system talks to Solana JSON-RPC and to Jupiter over HTTPS. No inbound ports
are opened and no listening socket exists.

### Measured latency to the public endpoint

`https://api.mainnet-beta.solana.com`, 12 sequential `getSlot` calls, 250 ms
apart, measured `2026-08-12T00:22Z`:

| | ms |
| --- | --- |
| min | 101 |
| p50 | 104 |
| p90 | 110 |
| max | 416 |

12 of 12 returned HTTP 200. The first request of the session took 453 ms; that
is TLS handshake, not steady-state latency.

Two things must be said about this measurement, because it is easy to read more
into it than it supports.

**It says nothing about `simulateTransaction`.** `getSlot` is a cheap method and
public endpoints rate-limit per method, not per connection. Effect verification
in `packages/execution/src/effect.ts` depends on simulation succeeding, and a
refused simulation is a refused trade — `simulation_unavailable` is a refusal,
not a warning. A dedicated RPC endpoint is therefore a hard gate for any mode
that can sign, and this measurement is not evidence against that requirement.

**It is a lower bound on the latency that matters.** 104 ms of round trip, plus
quote latency, plus signing, plus propagation, places this system nowhere near
the front of a block. That is a deliberate constraint rather than a shortfall:
the strategy is not permitted to compete in a first-block race, so the design
question is whether an edge survives at this latency, not how to shrink it.

### Clock

Local time read against the endpoint's HTTP `Date` header showed roughly one
second of apparent skew, which is inside the header's one-second granularity
plus round trip and therefore not a measurement of anything. Treat local wall
time as accurate to about a second and no better.

This matters in one specific place. Intent deadlines and
`lastValidBlockHeight` are both expiry mechanisms, but only one of them is a
proof. The block height comparison is authoritative because it is the chain's
own clock; `deadlineUtcMs` is a local convenience that a skewed host could get
wrong in either direction. The recovery path in
`packages/execution/src/machine.ts` expires an attempt on block height, never on
elapsed wall time, for exactly this reason.

## Secrets and configuration

Secrets come from the environment, loaded once by `loadSecrets()` in
`packages/domain/src/config.ts`. Every one of them is optional at the type
level — the function returns `string | null` for each — and the gating happens
at the point of use, so observe mode runs with nothing set at all.

| Variable | Purpose | Default |
| --- | --- | --- |
| `MODE` | run mode | `observe` |
| `SOLANA_RPC_HTTP` | primary RPC | none |
| `SOLANA_RPC_WS` | websocket RPC | none |
| `SOLANA_RPC_HTTP_FALLBACK` | secondary RPC, reads only | none |
| `HELIUS_API_KEY` | RPC provider; derives `SOLANA_RPC_HTTP` when that is unset | none |
| `JUPITER_API_KEY` | quote/swap provider; raises the `jupiter_main` bucket | none |
| `GOPLUS_ACCESS_TOKEN` | risk provider | none |
| `TRADING_KEYPAIR_PATH` | signing key file | none |
| `LIVE_ACK_PATH` | live-mode acknowledgement file | none |
| `DATABASE_PATH` | SQLite path | `./data/runtime.db` |
| `DATA_DIR` | artefact root | `./data` |

`SOLANA_RPC_HTTP_FALLBACK` is deliberately never used for `sendTransaction`.
Asking a second host to broadcast the same bytes during a partition is how one
transaction becomes two; the fallback exists for reads only.

### How the two provider keys are consumed

They are consumed differently, and the difference matters for where the
credential ends up.

`JUPITER_API_KEY` travels as an `x-api-key` **header**
(`packages/adapters/src/jupiter/client.ts`). It also selects a different rate
bucket: `RateLimiter.fromConfig(hasJupiterKey)` substitutes
`withKeyRequestsPerSecond` for `requestsPerSecond` on `jupiter_main`. Setting
the key therefore changes throughput as well as authentication, which is why the
substituted figure lives in `config/source-limits.json` next to its source URL
rather than in code.

`HELIUS_API_KEY` cannot travel as a header: Helius authenticates by **query
parameter**, so consuming the key means building a URL that contains it.
`heliusRpcUrl()` does that in one place, and `loadSecrets()` uses the result as
`rpcHttp` **only when `SOLANA_RPC_HTTP` is unset**. An explicitly configured
endpoint always wins; otherwise the configured value could name one host while
traffic went to another. `secrets.rpcHttpDerivedFromHeliusKey` records which
happened, and `pnpm doctor` reports `endpoint derived from HELIUS_API_KEY`
rather than claiming the operator set an endpoint they did not.

Because that URL is a live credential in string form, three things guard it:
the `api-key=` rule in `scrubSecrets()`, the `helius_url_with_key` rule in
`scripts/secretscan.ts` that fails the build if the assembled form is ever
committed, and `tests/unit/secrets.test.ts`, which asserts the redaction holds
when the URL is interpolated into an ordinary error message.

Before this wiring existed, `HELIUS_API_KEY` was loaded by `loadSecrets()` and
read by nothing. Doctor reported it present, so a key could be configured, be
reported as configured, and buy no on-chain capability at all — see O028 in
`docs/FAILURE_REGISTER.csv`.

`MODE` defaults to `observe` in `loadConfig()`. A missing or malformed mode
therefore yields the mode that cannot spend money, rather than an error the
operator might be tempted to route around.

No secret is ever written to the database or to a log line. `pnpm secretscan`
is part of `pnpm check` so that this claim is tested rather than asserted.

## What the design does not assume

- **No paid subscription is a hard dependency.** Every provider key above is
  nullable and the code must behave correctly when it is absent. How a null
  provider is treated is a strategy question with a real prior bug behind it;
  see `docs/STRATEGY_SPEC.md`.
- **No always-on host.** The system is expected to die at arbitrary points,
  including between signing and sending. Recovery is a first-class path, not an
  error handler.
- **No low-latency network.** See above.
- **No native compilation, no Docker, no external database, no message broker.**
  The full dependency set is `zod` and `pino` at runtime; everything else is a
  devDependency.

## Reproducing this environment

1. Node ≥ 24 and pnpm ≥ 11.
2. `pnpm install`.
3. Set `SOLANA_RPC_HTTP` to a dedicated endpoint. The public endpoint is
   sufficient for observe mode and is not sufficient for anything that signs.
4. `pnpm doctor` — reports what is present and what is missing without starting
   anything.
5. `pnpm check` — typecheck, secret scan, full test suite.

Step 5 is the one that establishes the tree is sound. Steps 1–4 only establish
that it is likely to start.
