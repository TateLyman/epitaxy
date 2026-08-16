# Cold, warm and repeat: who pays to open the accounts

**Directive section:** P6 — "the fastest mechanics win: do not be the account-setup payer"
**Status:** measurement wired; corpus not yet large enough to state a number.

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

## Three surfaces — still outstanding

The directive requires all three from the same original price state:

```
COLD                        as the chain is now
PREWARMED_NON_PRICE_ACCOUNTS  shared accounts transplanted in, reserves untouched
REPEAT                      the second trade through an already-warm pool
```

**Not yet produced.** The prewarmed surface is the delicate one: it may
transplant only non-price-bearing accounts into the original coherent snapshot,
and must not carry the first trade's reserve changes — otherwise it measures a
different market, not a warmer one.

Also outstanding from P6:

- appending the base token-account close to the sell where valid, so a third
  signature and landing interval is not spent merely to recover its rent
- setting the CU limit to measured use plus a frozen margin, since Solana
  charges priority fee against the **requested** limit rather than the consumed one

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
