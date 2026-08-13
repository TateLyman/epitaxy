# Offline replay: the Pump blocker

P4 / P5. Measured 2026-08-13 by `pnpm simulator:effect-parity` against a live
`Pump.fun Amm` route.

## The result

**JIT works. Offline replay does not.**

```
JIT      SIMULATED_OK   160,895 units
         input debit    exactly 20,000,000
         base fee       5,000     priority fee 9,500
         rent created   6,222,240
         created        1 account

offline  SIMULATION_UNKNOWN
         detail: cheatcode failed: surfnet_writeProgram:
                 error sending request for url (http://127.0.0.1:36831/)
         request size: 38.5 MiB
```

`SIMULATION_UNKNOWN`, not `SIMULATION_FAILED`. The replay did not run and did
not decide anything — the distinction the status column exists to preserve.

## The cause

A Pump route invokes **six programs**. Restoring it offline means redeploying
all six from their captured ELFs, and `net.deploy()` is a **synchronous napi
call**: it blocks the daemon's event loop for its entire duration.

The daemon already documents this, with the measurement that produced the
bound:

> during a six-program restore `/v1/health` stopped answering entirely and the
> daemon looked dead rather than busy … restoring them did not complete within
> five minutes

So the 38.5 MiB request and the dropped `surfnet_writeProgram` connection are
the symptom, not the disease. The disease is that a multi-megabyte deploy runs
on the request path.

This is a capacity problem in the restore mechanism, not a state-correctness
problem. The snapshot itself is complete: 26 accounts captured, 6 with ELFs,
**zero export omissions**.

## What it blocks

No Pump fingerprint can reach `OFFLINE_REPRODUCIBLE`, and `CONFIRMATORY`
requires it. So the venue carrying 4,545 of 26,515 observations — effectively
all of the opportunity in this corpus — is capped at `JIT_EFFECT_VALID` no
matter how many effect-verified runs it accumulates.

The canary readiness gate requires 200 confirmatory positions. Until this is
fixed, that number cannot reach one.

## What it does not block

Development collection. A JIT run that passes `SIMULATED_EFFECT_OK` is real
evidence about the strategy; it is simply not reproducible, because the same
transaction against a moving chain is two experiments.

That is not a figure of speech here. The same mint, the same size, minutes
apart:

```
run 1   SIMULATED_OK, 160,895 units, 20,000,000 debited
run 2   InstructionError [5, Custom 6001]   (slippage)
```

Which is exactly the argument for offline replay, and exactly why its absence
is a blocker rather than an inconvenience.

## The stable-pair route replays fine

The same script on SOL→USDC:

```
economic effect parity  AGREES
unitsConsumed           jit=40829 offline=40829   drift 0 bps
```

So the offline mechanism is sound; it is the six-program restore that fails.
This is also why a single failed parity run on a stable pair must never be read
as "the simulator cannot do offline replay" — it did, here, exactly.

## Fixes

Splitting the body into one request per program does **not** fix this, and it
was the first thing I reached for. The cost is in `deploy()` itself, not in the
transport: six synchronous multi-megabyte deploys block the loop for the same
total time whether they arrive in one request or six.

In order of preference:

1. **Cache deployed programs across replays.** Pump's six programs are the same
   on every Pump route. The first replay of the day pays the deploy; every
   later one redeploys nothing. This is the only fix that makes the common case
   fast rather than merely survivable, and it needs no change to `deploy()`.
2. **Move the deploy off the request path** — a worker thread, or a queue with
   the replay resuming when the restore completes. Correct, and a larger change
   to the daemon's shape.
3. **Raise the cheatcode timeout.** Least preferred: it makes a slow path
   tolerable instead of fast, `/v1/health` still stops answering, and the next
   route with a seventh program finds the next limit.

**Not attempted in this session.** The daemon's JIT path is working and is the
only thing currently producing evidence; a restructuring of its restore loop at
the end of a long session risks the one path that works, to fix a path that
blocks a gate nothing is close to reaching. It is recorded as `S050` in the
failure register with its measured cause.

## Slot interval

Recorded rather than fabricated, per P4:

```
build contextSlot   not reported by the provider
JIT contextSlot     439073167
offline targetSlot  439073167
same-slot truth     NO
```

Jupiter omits `contextSlot` on these builds. The JIT run reports the slot it
actually executed at and the offline replay is asked to stand there, so the two
runs share a clock. That models decision latency faithfully and is **not**
same-slot truth, and it is not recorded as such.


---

# After P8 Step 1 — the blocker moved, and is now located precisely

`soPath` was already in `DeployOptions`. Each ELF is now written once to a
content-addressed file and deployed by path. The cache proves it is in use:

```
2892224   2e02a40329aa...so
10485715  e97dab8f7b00...so
```

Two programs written, 13 MB total. The deploy reaches the second one and then:

```
offline  SIMULATION_UNKNOWN
         cheatcode failed: surfnet_writeProgram:
                 error sending request for url (http://127.0.0.1:35405/)
```

## What this rules out

**It is not N-API marshalling.** That was the diagnosis, and it was reasonable —
`soBytes` converts a multi-megabyte ELF element by element on the request
thread. `soPath` removes that entirely, and the failure is unchanged.

**It is not the 38.5 MiB HTTP body either.** That request is the Windows engine
sending the snapshot to the daemon, and it arrives: the daemon restores 26
accounts and gets as far as writing the second program.

## What it is

`net.deploy()` issues `surfnet_writeProgram` over the surfnet's *own* RPC, and
that connection drops while writing a **10.5 MB** program. The failure is inside
Surfpool's program-write path, one layer below anything this daemon controls.

So the remaining options are the ones that do not use it:

- **Step 3, a pinned Rust Surfpool worker** — same runtime, but the write
  happens in-process rather than across an RPC boundary.
- **Step 4, a pinned Rust LiteSVM worker** — LiteSVM loads raw programs
  directly, which is exactly the operation failing here.

Step 2 (an isolated child process per offline job) would stop a hung restore
taking the daemon with it, which is worth having, and it would not make this
write succeed.

## Status

`S050` remains OPEN with a sharper cause. Pump is still capped at
`JIT_EFFECT_VALID`, and `CONFIRMATORY` is still unreachable for it.

What changed is that the next step is now a known piece of work against a known
layer, rather than a guess. Step 1 was the cheap fix and it was worth trying:
it is a real improvement to the deploy path, it is kept, and it demonstrated
that the cost is not where it was believed to be.
