# THREAT MODEL

What can take the money, what can corrupt the record, and which of those this
system actually defends against.

## Scope and the assumption underneath everything

The asset under protection is a hot wallet whose private key is on disk on a
Windows desktop, used by an unattended process that talks to third-party APIs
and signs Solana transactions.

**If the host is compromised, this system is compromised.** An attacker with
code execution as the operating user can read `TRADING_KEYPAIR_PATH`, and
nothing in this repository prevents that. Every mitigation below is written
against a threat model where the host is intact and the *inputs* are hostile.
Host compromise is mitigated operationally — by the wallet holding only what the
operator can afford to lose — not by code.

That is the honest boundary. A document that claimed otherwise would be worse
than no document.

## The adversaries

| # | Adversary | Wants | Reaches us via |
| --- | --- | --- | --- |
| A1 | Token deployer | Sell us a token that cannot be sold back | Token metadata, on-chain state, liquidity |
| A2 | Compromised or hostile quote provider | Get a transaction signed that they wrote | Jupiter swap response |
| A3 | Hostile or lying RPC endpoint | Distort what we believe about the chain | Every RPC read, including simulation |
| A4 | Network adversary / partition | Cause the same trade to execute twice | Dropped or duplicated responses |
| A5 | Enrichment provider | Poison scoring inputs, or exfiltrate | Helius / GoPlus / DexScreener responses |
| A6 | Dependency supply chain | Arbitrary code in-process | npm install |
| A7 | The operator | Bypass a gate that was inconvenient | Config, env, direct DB edits |
| A8 | Ourselves | A defect that spends money | The code |

A8 is not a joke entry. It is the adversary with the best access.

## A2 — the signing surface, and why it is the whole design

A function that accepts bytes and returns a signature has delegated the question
of where the money goes to whoever produced the bytes. Jupiter is a reasonable
counterparty; the system still does not extend it that trust, because the
failure is unbounded. Every other defect here costs a trade. This one costs the
wallet.

`Signer.sign()` therefore does not accept a transaction. It accepts a
transaction **together with the intent that asked for it and independent
evidence of what the bytes will do**, and refuses unless three checks agree.
There is no force parameter.

The full mechanism is in [EXECUTION_POLICY.md](EXECUTION_POLICY.md). What
matters for the threat model is the division of labour, because each layer fails
to a *different* adversary:

| Layer | Trusts | Defeated by |
| --- | --- | --- |
| Policy (`txpolicy.ts`) | nothing but the bytes | nothing — it is pure decode |
| Binding (`binding.ts`) | nothing but the bytes and our own intent | nothing — but it proves less than it appears to |
| Effect (`effect.ts`) | the RPC endpoint's simulation | A3, a lying endpoint |

**Only the third layer trusts anything external.** That is deliberate and it is
the reason all three are required.

### What binding actually proves, stated precisely

`lamportOutflowFromPayer` sums System Program Transfer instructions (4-byte LE
tag `2`, data length exactly 12) whose first account index is 0. Account index 0
is the fee payer by definition of the Solana message format, so those are
lamports leaving us.

It is important not to overread this. **A Jupiter swap does not move SOL with a
System Transfer.** The SOL leg goes through wrapped SOL, inside instruction data
this layer deliberately does not parse. So binding's outflow bound catches
explicit drains — a transaction that simply transfers our lamports away — and
does *not* bound the swap amount.

That gap is the entire reason the effect layer exists, and the reason the
comment at the top of `binding.ts` says the narrowness is the point. A layer
that guessed at Jupiter's Anchor discriminator would produce a bound that looks
authoritative and silently is not, which is strictly worse than a bound that
declares its own limits.

One refusal is worth calling out as a design principle rather than a check: a
System Transfer whose data length is not 12 does not get skipped and does not
get guessed at. It raises `undecodable_system_transfer` and the transaction is
refused. **An amount we cannot read is not an amount we can bound.**

## A3 — a hostile RPC endpoint

This is the most interesting adversary, because the effect layer trusts it.

An endpoint that lies about simulation results can defeat effect verification
directly: report a favourable output balance for a transaction that does
something else. There is no cryptographic defence against this — simulation is
an assertion by a remote host.

What bounds the damage is that the *other two layers do not consult it*. A
lying endpoint must still get past a transaction whose programs are all on the
allowlist, whose fee payer is us, which requires only our signature, whose
priority fee is inside the intent's ceiling, and whose explicit lamport outflow
is inside the intent's ceiling. The endpoint cannot forge those; they are
computed from bytes we hold.

So the residual exposure to A3 is: **a swap that routes through allowlisted
programs and produces a worse fill than simulated.** That is a bounded loss on
one position, not a drained wallet. It is a real cost and it is accepted.

Three secondary A3 behaviours are handled explicitly:

| Endpoint behaviour | System response | Why |
| --- | --- | --- |
| Refuses to simulate | `simulation_unavailable` — refusal, not warning | An unverified transaction is not signed |
| Cannot be reached for block height | Nothing is marked expired on that pass | An unreachable chain is not permission to guess |
| Returns no signature status | Attempt stays `UNKNOWN` and keeps blocking | Absence is evidence only once the blockhash is provably dead |

`sendTransaction` is **never** failed over to `SOLANA_RPC_HTTP_FALLBACK`. The
fallback is reads only. Asking a second host to broadcast the same bytes during
a partition is how one transaction becomes two.

## A4 — double execution

Two independent paths lead to the same trade happening twice, and they need
different defences.

**Concurrent processes.** Two engines sizing against the same balance is
catastrophic rather than degraded. The `process_locks` table plus the
`ProcessLock` heartbeat make this a startup refusal. A lock whose heartbeat is
fresh and whose pid is not ours means someone else is running; the second
process does not start.

**Retry after an unclear send.** A send whose response was never seen has three
possible truths — never broadcast, broadcast and landed, broadcast and failed —
and only one is safe to retry. Retrying on error buys the same token twice with
the same money about as often as the network hiccups.

The ordering is fixed and the order *is* the mitigation:

1. Sign, and read `lastValidBlockHeight`.
2. **Write the attempt row, carrying the signature, to SQLite.** Durable before
   the wire.
3. Send. On success `SUBMITTED`; on throw **`UNKNOWN`, never `FAILED`**.
4. Poll until confirmed, failed, provably expired, or timed out.

Step 2 before step 3 is what makes the system recoverable: everything after that
point is reconstructible from the chain using the stored signature, and nothing
before it needs to be.

`resolveOutstanding()` returns the count of attempts of unknown fate and
`apps/executor/src/main.ts` refuses to trade while it is nonzero. The wallet may
hold a position nobody recorded, and sizing the next trade against a balance we
do not understand is how a small failure compounds.

Two further constraints are enforced by the database rather than by a caller
remembering:

- `execution_attempts.signature` carries a UNIQUE index, so two rows can never
  claim one transaction.
- The idempotency key is a UNIQUE constraint enforced by `INSERT OR IGNORE`, not
  a read-then-write. Read-then-write is not atomic across a crash, and a crash
  is precisely what interrupts this operation.
- Since migration 4, `execution_attempts.intent_id` is a real foreign key. An
  attempt whose intent does not exist resolves into nothing: the signature is on
  chain, the process believes it handled it, and no intent ever changes state.

Every one of these is exercised in `tests/chaos/recovery.test.ts`, where the RPC
and signer stubs throw on any call a given test does not expect — so "the code
did not reach the network" is asserted rather than assumed.

## A1 and A5 — hostile strings from outside

Token names and symbols are attacker-controlled strings that arrive in our logs,
our database, and any terminal a human reads. They are treated as data and
never as instructions.

`sanitizeExternal()` in `packages/observability/src/log.ts` strips, by code
point: C0 controls, C1 controls, zero-width and directional marks
(`U+200B`–`U+200F`), line/paragraph separators and bidi overrides
(`U+2028`–`U+202E`), bidi isolates (`U+2066`–`U+2069`), and `U+FEFF`. Then it
caps length, then it scrubs secrets.

Each class is there for a reason:

| Class | Attack it prevents |
| --- | --- |
| C0/C1 controls, `U+2028`/`U+2029` | Log forging — a "name" containing a newline that fabricates a log line |
| Bidi overrides and isolates | Display spoofing — a symbol that renders as a different token in a review |
| Zero-width marks | Homoglyph and identity confusion |
| Length cap (120 default) | Storage and log flooding |

External strings are also never used as a format string, and provider error
bodies are capped and sanitised before they enter an exception message.

Beyond text, A1's real weapon is economics rather than encoding: a token that
can be bought and not sold. That is a strategy problem, not a parsing problem,
and it is handled by the gates documented in
[STRATEGY_SPEC.md](STRATEGY_SPEC.md). The relevant threat-model property is that
the sell side is priced *before* the buy — a token with no sell route is refused
entry, and a position that becomes unsellable reaches the explicit
`EXIT_BLOCKED` terminal state rather than being retried forever in silence.

## Secret handling

| Control | Where |
| --- | --- |
| Secrets read from env only, never from the database | `loadSecrets()` |
| Redaction by key path (`apiKey`, `privateKey`, `authorization`, …) | `REDACT_PATHS` |
| Value-level scrub of URL key parameters | `scrubSecrets()` |
| Value-level scrub of anything base58 and ≥ 80 chars | `scrubSecrets()` |
| Repository-wide scan | `pnpm secretscan`, inside `pnpm check` |

The base58 length heuristic exists because a redaction list can only cover keys
someone thought of. A key pasted into a URL, an error message, or a field name
nobody enumerated still looks like a long base58 run.

Key material itself never becomes bytes in our address space after load. The
seed is wrapped into a `KeyObject` via PKCS#8 and the class exposes no accessor
that serialises it back.

Two checks run at load, and both are refusals:

- **File permissions.** A keypair readable by group or world is rejected outright
  rather than warned about.
- **Self-consistency.** The public half stored in the file is compared against
  the half derived from the seed. A file whose two halves disagree is a file
  that will sign for an address the operator is not watching, and that is a
  refusal rather than a preference for one half over the other.

## A6 — supply chain

The runtime dependency set is two packages: `zod` and `pino`. Everything else —
TypeScript, tsx, vitest, fast-check — is a devDependency and is not loaded by a
running trader.

There is no native addon. `node:sqlite` is built into Node, which removes both a
compilation toolchain and a postinstall script from the trust boundary. There is
no HTTP server, no listening socket, and no inbound surface.

This is not a claim of safety. `zod` and `pino` are transitively trusted with
in-process code execution and a malicious release of either would be
game over. It is a claim that the surface is small enough to audit, which is the
only honest thing to claim about npm.

## A7 — the operator, and gates that cannot be argued with

The mode ladder is `observe → paper → canary → live`, and a mode is entered by
evidence rather than by decision. Gates are evaluated against measurements in
the database, not against a human's assessment of readiness. The practical
property is that **a gate cannot be satisfied by disagreeing with it.**

Structural controls, in decreasing order of strength:

1. **The import graph.** `packages/solana/src/rpc.ts` has no `sendTransaction`
   method at all. Every write method lives in `packages/execution/src/rpc.ts`,
   in a package that observe, paper, replay and backtest never import. Observe
   mode cannot broadcast a transaction because the code to do so is not reachable
   from it — not because a flag says no. A flag can be flipped by a defect; an
   import that does not exist cannot.
2. **Mode asserted twice.** The executor takes `--mode` from the command line
   *and* compares it against the mode in the loaded config, refusing if they
   disagree. One of them being wrong is then a refusal rather than a surprise.
3. **Default is observe.** A missing or malformed `MODE` yields the mode that
   cannot spend money.
4. **Live requires an out-of-band acknowledgement file** (`LIVE_ACK_PATH`), so
   entering live is a deliberate act on the filesystem rather than a flag in a
   shell history.
5. **`signerAllowed(mode)`** is false for anything but canary and live, and
   `assertSignerNotAllowed` throws if it is ever reached in those modes — a
   tripwire for an internal invariant, not an input check.

None of this stops an operator with a SQLite client from editing the gate inputs
directly. That is out of scope by the same reasoning as host compromise: a
determined operator can always defeat their own safety rail. The gates exist to
stop a *hurried* operator, and that is the realistic failure.

## A8 — us

The mitigations that target our own defects are the ones with the least
glamour and the most value.

- **Bigint everywhere for token amounts.** A token with nine decimals and a
  large supply produces raw amounts that overflow a double long before they
  overflow a u64. Amounts are `bigint` in code and TEXT in SQLite, because
  SQLite INTEGER is 64-bit *signed* and would truncate near the top of the
  range. `tests/property/amounts.property.test.ts` asserts the invariant that
  matters: outputs round down, fees round up, and the two roundings partition
  the amount exactly — otherwise every trade silently creates or destroys a
  lamport.
- **Base58 is property-tested for leading zeros.** An encoder that dropped one
  would produce a *different address that still looks plausible*, which is the
  class of bug that survives review and fails at the wallet.
- **The signer re-decodes and byte-compares after writing the signature.** A
  signature written at the wrong offset would otherwise be discovered by the
  cluster rather than by us.
- **Fills are written from the chain, never from the quote.** `pnpm reconcile`
  is the only path permitted to write fills for on-chain trades, and it derives
  them from `getTransaction` balance deltas. The quote is what we hoped for; the
  balances are what happened.
- **Refusals are recorded.** A signer that declines a thousand transactions and
  never says why is indistinguishable from one that is simply broken, so
  `sign_refusals` stores the kind and the detail.

## Known residual risk

Stated plainly, because a threat model that lists only what it defeats is
marketing.

| Risk | Status |
| --- | --- |
| Host compromise reads the keypair | Not mitigated in code. Wallet sizing only. |
| A lying RPC produces a bad fill within the policy and binding bounds | Accepted. Bounded to one position. |
| Jupiter's swap amount is not bounded by parsing | Accepted and documented. Effect layer bounds it empirically instead. |
| A route whose output account is reachable only via an address lookup table | Refused (`output_account_not_found`). A valid trade is lost. Bounded loss preferred over unbounded signature. |
| `fills.intent_id` has no foreign key and holds a snapshot id in paper mode | **Open defect.** See DATA_DICTIONARY.md. Corrupts joins, not money. |
| Effect verification depends on an endpoint that will simulate | Accepted, and the reason a dedicated RPC is a hard gate for signing modes |
| `zod` / `pino` supply chain | Accepted, minimised |
| Operator with direct database access | Out of scope |

The last word belongs to the asymmetry that shapes all of it: **refusing a valid
trade is a bounded loss; signing an unbounded one is not.** Wherever this system
has to choose, it chooses the refusal.
