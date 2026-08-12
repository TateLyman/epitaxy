# EXECUTION POLICY

What this process is permitted to sign, and what it must prove first.

## The shape of the problem

A signing function is a remote code execution primitive pointed at your own
wallet. Anything that takes bytes and returns a signature has delegated the
decision about where the money goes to whoever produced the bytes. Jupiter is a
reasonable counterparty and this system still does not extend it that trust,
because the failure is unbounded: every other defect in this repo costs a trade,
a signer defect costs the wallet.

So the signer does not accept arbitrary serialized transactions. It accepts a
transaction *together with the intent that asked for it*, and refuses unless
three independent checks agree.

## The three layers

`Signer.sign()` runs them in order and stops at the first refusal. None is
optional, and each answers a different question.

### 1. Policy — is this structurally sane?

`packages/solana/src/txpolicy.ts`. Operates on the decoded transaction alone.

| Check | Refusal |
| --- | --- |
| We are the fee payer (account index 0) | `wrong_fee_payer` |
| Every invoked program is on the allowlist | `disallowed_program` |
| Instruction count within bounds | `too_many_instructions` |
| Computed priority fee within the ceiling | `priority_fee_too_high` |
| We are the only required signer | `unexpected_signer_count` |

The priority-fee ceiling is not a separate configured number. It is derived from
the intent's `maxPriorityFeeLamports`, so the policy layer and the binding layer
cannot disagree about what was authorised. Fee is computed as
`unitLimit × unitPriceMicroLamports / 1_000_000`, from the ComputeBudget
instructions actually present in the transaction.

### 2. Binding — does this match the intent we formed?

`packages/execution/src/binding.ts`. Deliberately narrow.

| Check | Refusal |
| --- | --- |
| The intent has not expired | `intent_expired` |
| Priority fee within the intent's ceiling | `priority_fee_exceeds_intent` |
| Lamport outflow from the fee payer within the intent's ceiling | `lamport_outflow_exceeds_intent` |
| Every System Transfer is decodable | `undecodable_system_transfer` |

Outflow is summed over System Program Transfer instructions (4-byte LE tag `2`,
data length exactly 12) whose first account index is 0 — the fee payer, by
definition of the Solana message format. The ceiling is
`maxInputAmount + maxTotalFeeLamports` for a buy and `maxTotalFeeLamports` alone
for a sell, because a sell spends tokens rather than SOL.

A System Transfer whose data length is not 12 does not get skipped, and does not
get guessed at. It increments `undecodable_system_transfer` and the transaction
is refused. **An amount we cannot read is not an amount we can bound.**

### 3. Effect — what will these bytes actually do?

`packages/execution/src/effect.ts`. Answered by simulation, not by parsing.

| Refusal | Meaning |
| --- | --- |
| `simulation_failed` | the cluster says this transaction reverts |
| `simulation_unavailable` | the cluster would not simulate it |
| `output_account_not_found` | we cannot see where the output lands |
| `output_below_minimum` | simulated output under the intent's floor |
| `input_above_maximum` | simulated input over the intent's ceiling |
| `unexpected_mint_movement` | a mint moved that neither leg accounts for |

The transaction is simulated with `sigVerify: false` and
`replaceRecentBlockhash: true`, requesting post-execution account data for every
static account key. SPL token accounts are decoded at the fixed offsets
(mint 0, owner 32, amount 64, u64 LE) and only accepted when owned by the SPL
Token or Token-2022 program. Balances are summed **by mint across every touched
account we own**, because a route may legitimately use more than one account for
the same mint. The SOL leg is measured as a lamport delta, since SOL is held
natively rather than in a token account.

Wrapped SOL is exempt from the third-mint check: routing through wSOL is how a
SOL leg executes, not evidence of an unexpected movement.

## Why the amount bound is measured rather than parsed

This is the load-bearing admission in the design.

Jupiter's swap amounts live inside Anchor instruction data. Bounding them by
parsing would require the instruction discriminator and field layout, and I could
not verify either against a current official source at the time of writing. A
hardcoded, remembered layout would produce a check that *appears* to bound the
trade and silently does not — strictly worse than no check, because it would be
believed.

The design therefore splits the problem. Binding bounds only what the transaction
bytes prove unambiguously without knowing any program's internals. Effect
establishes the amount bound empirically, by simulating and diffing balances. The
signer requires both.

The cost of this choice is honest and worth stating: **effect verification
depends on the RPC endpoint.** A cluster that will not simulate produces
`simulation_unavailable`, which is a refusal, not a warning. The trade does not
happen. This is also why a dedicated RPC endpoint is a hard gate for any mode
that can sign — the public endpoint's method-level rate limiting would convert
into a stream of refusals at best.

A second cost: only static account keys are inspected. A route whose output
account is reachable only through an address lookup table yields
`output_account_not_found`, and the trade does not happen. Refusing a valid trade
is a bounded loss; signing an unbounded one is not.

## After the signature

`writeSignature` places the 64 signature bytes into slot 0, computing the shortvec
prefix length from the bytes rather than assuming it is 1. The signer then
**re-decodes the transaction and byte-compares the message** against what it
signed. A signature written at the wrong offset would otherwise be discovered by
the cluster rather than by us.

## The unknown-fate protocol

A send whose response is never seen has three possible truths — never broadcast,
broadcast and landed, broadcast and failed — and only one of them is safe to
retry. Retrying on error buys the same token twice with the same money about as
often as the network hiccups.

So the ordering is fixed:

1. Sign. Read `lastValidBlockHeight` as an upper bound on the blockhash's life.
2. **Write the attempt row, carrying the signature, to SQLite.** Durable before
   the wire. Everything after this point is reconstructible from the chain using
   that signature; nothing before it needs to be.
3. Send. On success, `SUBMITTED`. On throw, **`UNKNOWN` — never `FAILED`.**
4. Poll for status until confirmed, failed, provably expired, or timeout.

`sendTransaction` is never failed over to a secondary endpoint. Asking a second
host to send the same bytes under a network partition is how one transaction
becomes two.

### Expiry is a proof, not a timeout

An attempt is marked `EXPIRED` only once the observed block height exceeds its
recorded `lastValidBlockHeight`. Before that, a missing status means "not yet".
If the block height cannot be read at all, nothing is marked expired on that
pass — an unreachable chain is not permission to guess.

### Unresolved attempts block everything

`resolveOutstanding()` returns the number of attempts still of unknown fate, and
`apps/executor/src/main.ts` refuses to trade when it returns nonzero. The wallet
may hold a position nobody has recorded, and sizing the next trade against a
balance we do not understand is how a small failure compounds.

## Idempotency

The idempotency key is `sha256(strategyVersion|mint|side|amount|epochMs)`
truncated to 32 hex characters, and it is enforced by a UNIQUE constraint via
`INSERT OR IGNORE` — not by a read-then-write. Read-then-write is not atomic
across a crash, and a crash is precisely what interrupts this operation.

A duplicate claim returns immediately, before the signer or the network is
touched. Whatever state the earlier run reached is authoritative; re-deriving it
would be a second opinion about money that has possibly already moved.

`execution_attempts.signature` additionally carries a UNIQUE index, so two rows
can never claim one transaction. The database refuses instead of the caller
remembering to.

## Fills are written from the chain, never from the quote

`pnpm reconcile` is the only path permitted to write fills for on-chain trades,
and it derives them from `getTransaction` balance deltas. The quote is what we
hoped for; the balances are what happened.

It records `priorityFeeLamports: 0` because `getTransaction` does not separate
the priority component from the base fee. A fabricated split would corrupt the
very cost model that depends on it.

## What is not implemented

The entry/exit loop is absent from `apps/executor/src/main.ts` rather than
stubbed. A stub that appears to trade and does not is worse than a gap you can
see. It lands once canary has demonstrated the signable path end to end — which,
as of this writing, nothing has: all quotes to date report
`transaction_buildable = 0`, correctly, because quote-only requests omit `taker`.
