# Cold, warm and repeat: who pays to open the accounts

**Directive section:** P6 — "the fastest mechanics win: do not be the account-setup payer"
**Status:** measurement wired and the three surfaces are built.
**The surface has not been RUN** — `pnpm size:cold-warm-surface` needs live RPC
and the daily quota is exhausted. No number below was inferred rather than
measured.

## The finding this exists to correct

The proof artifact showed round-trip drag clustering at roughly:

```
-0.000509 SOL      warm
-0.002547 SOL
-0.004333 SOL
-0.006372 SOL      cold
```

and reported **zero created-account rent on every single row**.

That zero was not a measurement. The observe set did not contain the accounts
the transaction created, and an account nobody observed reports identically to
one that cost nothing. The size surface then labelled the residual a *recurring
mechanics floor* and recommended a larger notional to amortise it.

Both halves of that are wrong:

- it is not recurring — most of it is a one-time setup cost
- it is not a floor — a second trade through the same pool does not pay it

A larger notional does not make a first trader's rent smaller. It hides the rent
behind a size the strategy then has to justify on other grounds.

## What is measured now

For every account the entry brings from absent to present, the collector records:

| column | meaning |
| --- | --- |
| `pubkey`, `owner`, `space` | identity and size |
| `rent_exempt_min` | what the chain requires for `space` bytes — **only this is rent** |
| `excess_lamports` | balance above the exemption |
| `economic_scope` | how many future trades opening it serves |
| `recoverability` | whether the lamports come back, and to whom |
| `shared_with_other` | would another trader's organic transaction have opened it |

`excess_lamports` is not pedantry. The coin-creator fee vault is opened **and
paid** in one transaction, so its closing balance is rent plus a fee the pool
sent it. Crediting the whole balance back to the payer flattered every sell by a
few basis points, and by 94 on one of them.

## The distinction that carries the economics

```
RECOVERABLE_BY_US      a float — we hold close authority, closing returns it
RECOVERABLE_BY_OTHER   we paid, they can close it and keep the lamports
NOT_RECOVERABLE        nobody closes it; gone from everyone
UNKNOWN                unclassified, and therefore never assumed free
```

Collapsing these into one "rent" figure is what made a one-time payment look
like a per-trade cost. Kept apart:

- **recoverable** rent is working capital, not expense
- **unrecoverable** rent belongs in execution cost
- **subsidy** — rent we paid for accounts every later trader gets free — is the
  quantity the whole P6 hypothesis is about

A five-account cold setup is `5 × 2,039,280 = 10,196,400` lamports, i.e. about
**0.0102 SOL**. That is the same order as the largest drag cluster the artifact
reported as zero rent, which is why the reconciliation matters.

## The stratum boundary

`requiresSharedAccountCreation` decides whether a candidate is COLD or WARM. It
returns true when the entry opens a shared protocol account **or an account it
could not classify** — because *we did not recognise it* must not read the same
as *it costs nothing*, which is precisely the substitution that produced the
zeroes.

Primary development sampling should prefer warm candidates and place cold ones
in their own stratum rather than in the same average. The point is not that cold
candidates are bad; it is that another trader's organic transaction will warm
those shared accounts shortly, and the opportunity cost of waiting is usually
smaller than the rent.

## Three surfaces — built, not yet run

`pnpm size:cold-warm-surface` produces all three from the SAME original price
state:

```
COLD                          we open every shared account ourselves
PREWARMED_NON_PRICE_ACCOUNTS  somebody else opened them; reserves UNTOUCHED
REPEAT                        the second trade, after the first moved the pool
```

The two differences answer different questions and recommend opposite things:

```
COLD − PREWARMED   = setup cost.   One-time.   Says WAIT FOR A WARM POOL.
PREWARMED − REPEAT = self-impact.  Recurring.  Says TRADE SMALLER.
```

That is exactly why the prewarmed surface is the delicate one. The wrong version
of it — "run the trade, then run it again from the post state" — is REPEAT
wearing PREWARMED's label, and it reports setup cost *plus* self-impact as one
number, from which neither recommendation follows.

`prewarmNonPriceAccounts` therefore refuses a price-bearing transplant **by
name**, and refuses on the REQUEST rather than on whether the account happened to
move: a check that passed because this particular run left the mint alone would
pass right up until the run where it did not.

It has NOT been run. It needs live RPC and the daily quota is exhausted.

## The other two P6 items, both done

**The close rides in the sell.** It used to be a third transaction with its own
signature and its own landing interval, spent purely to recover ~2,039,280
lamports of rent. The lamports are worth the 5,000 lamport signature; the
interval is the expensive part, and a second transaction is one more thing that
can fail once the position is already flat.

Whether it worked is read from the sell's own post-state. "We appended a close"
and "the account is gone" are different claims and only the second is evidence,
so a close that did not take effect is named in `incompleteness` rather than
assumed.

**The compute limit is measured.** Solana charges the priority fee against the
REQUESTED limit, so a five-instruction leg that consumes 90,000 units pays
against roughly 1,000,000. At 10,000 microlamports that is 8,920 lamports per leg
for nothing — about 35 bps of round-trip drag purchasable with one instruction.

`frozenComputeLimit` returns null when nothing was measured rather than a
default, because a guessed limit is indistinguishable in the transaction from a
measured one and is costly in both directions: too low fails the leg, too high
overpays on every leg after. The 20% margin is FROZEN rather than tuned — a
failed leg costs the whole base fee and the landing interval, so the asymmetry is
severe and the margin leans deliberately toward landing.

## Reading it

```bash
pnpm trajectory:collect --once
```

prints, per cycle:

```
setup accounts : N across M trajectories — rent R, recoverable C, subsidy S
```

`S` is the number to watch. If it is a large fraction of total drag, the answer
is to wait for a warm pool, not to trade a bigger size.

## What this is not

No profitability claim. These are costs measured in an isolated local runtime
against exact captured state; nothing here has been funded, signed or submitted,
and a mechanics measurement is not a strategy outcome.
