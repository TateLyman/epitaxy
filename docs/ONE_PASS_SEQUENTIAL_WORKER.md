# The one-pass sequential worker

`offline-worker/src/main.rs` (`--serve`) · `packages/simulator/src/sequential-worker.ts`
`scripts/one-pass-sequential-proof.ts` → `artifacts/one-pass-sequential-proof.json`

## The two defects this removes

### 1. The two-pass architecture

The proof ran the buy in runtime instance **A** to learn what it produced, built
the sell from that, then ran buy-then-sell in a **fresh instance B**.

Two instances replaying the same buy *ought* to agree. Nothing checked that they
did, and a sell priced against a state it did not execute in is not an exact
sequential mechanic — it is an approximation that looks exactly like one.

Worse, the design made the question **unanswerable**. Comparing an account across
two runtimes proves they agreed on a replay; it says nothing about whether one
quote and one execution saw a single state, because they never shared a runtime.

### 2. The blocking call

`runSequential` uses `execFileSync`, which stops the Node event loop for the
whole run — up to four minutes. In a process that is also marking positions on a
schedule, that is not a performance question. The mark scheduler does not run,
and marks that never happened are indistinguishable afterwards from marks that
found nothing.

## The mechanism

The worker gains a `--serve` mode: newline-delimited JSON on stdin/stdout, one
command per line, one response per line, in order. **One runtime stays alive
across commands.**

```
init  → build the runtime from a coherent snapshot
step  → execute a transaction and COMMIT it
observe → read state WITHOUT executing, so the caller can build the next leg
close
```

Which makes the real sequence expressible:

```
init → step(buy) → observe(price-bearing accounts)
     → [caller builds the sell from THOSE bytes]
     → step(sell)        ← same runtime, same committed state
```

`build_runtime` and `execute_step` are shared by both modes, so the one-shot and
serve paths cannot drift into executing transactions differently — which would
make their results incomparable while looking like the same worker.

## The required assertion

```
state used to quote sell == state immediately before sell execution
```

`assertQuoteStateSurvived` compares the accounts returned by `observe` against
the sell step's own `preAccounts`, **per account, by content hash**, so a failure
names *which* account moved rather than only that something did.

Two details that make it a real check rather than a decoration:

- **An account that vanished between quote and execution counts as moved.**
  Absent is not "unchanged"; silently ignoring it is how a missing vault reads as
  agreement.
- **An empty quote vacuously passes**, and this is documented rather than hidden.
  The function cannot distinguish "nothing moved" from "nothing was quoted". The
  caller naming the price-bearing accounts is what gives it meaning.

The proof script also runs the **negative case** — feeding the assertion a
deliberately moved account and requiring it to object. A check that cannot fail
is not a check, and the previous directive pass shipped exactly that mistake in
the coherent-snapshot proof.

## Proof results

```
runtime persists across commands          true
state restored exactly as supplied        true
a refused step does not move the state    true   (hash identical before/after)
quote state survived to execution         true
the check detects a moved account         true
an absent account is named, not zeroed    true
```

## Bounds

- **Per-command timeout.** A worker that hangs is a worker that lies. On timeout
  the pending slot is removed *before* the process is killed, so a late reply
  cannot be handed to the next caller — which would silently pair a response with
  the wrong request.
- **Output bound.** Stdout beyond the limit kills the worker rather than growing
  the heap.
- **Crash handling.** Process `error`/`exit` reject every pending caller instead
  of leaving them awaiting forever.
- **No network.** The binary opens no sockets. Signature verification and
  blockhash checking are off, which is a property of this system rather than a
  shortcut: nothing here ever signs, and these transactions carry a mainnet
  blockhash this runtime has never seen.

## What is NOT done

**The real buy → observe → build-sell → sell loop against a live pool is not
wired in.** The runtime property is proven, and `scripts/true-stateful-proof.ts`
still contains the pass-1/pass-2 structure this replaces. Converting it needs the
sell builder to be driven from `observe` output rather than from a first-pass
result, which is the next change and is not made here.

So this module makes a correct sequential trajectory *possible*. It does not by
itself make one *exist*, and the terminal state does not move on it.
