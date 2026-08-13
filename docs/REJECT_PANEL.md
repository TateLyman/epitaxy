# Reject panel

P19. What happened to the tokens the gates turned down. `pnpm reject:status` →
`artifacts/reject-status.json`.

The panel exists because a gate can only be evaluated against the outcomes of
what it rejected. Without it, every gate looks correct: nothing it refused ever
appears in the results.

## The defect it was built to avoid, and the one it had anyway

`price_usd` is nullable. A NULL price read as a number is zero, and zero means
the token went to nothing — so every gate looks brilliant, because the things it
rejected all "went to zero". What actually happened is that a provider stopped
answering.

That error always flatters the gates, and it is largest exactly where the data
is thinnest, which is where a rejected token is most likely to be.

The classifier was written to fix it. The **backtest still had the same bug in
another form**: `o.ret ?? -1` mapped every unquoted token to −100%. The reasoning
was survivor bias — dropping them would flatter the panel — and it fixed one bias
by installing its mirror image.

## The classification

```
EXECUTABLE_VALUE        a route exists and returns value
NO_ROUTE_CONFIRMED      no route at any size
POOL_DRAIN_CONFIRMED    the reserves are gone
UNBUILDABLE             a route quotes and cannot be assembled
PROVIDER_MISSING        the provider stopped answering about it
SOURCE_GAP              our own collection had a hole
SIMULATION_UNAVAILABLE  the simulator could not answer
UNKNOWN                 looked, and could not tell
```

**Only the first four are economic statements.** `NO_ROUTE_CONFIRMED`,
`POOL_DRAIN_CONFIRMED` and `UNBUILDABLE` are −100%: a holder cannot exit.
`PROVIDER_MISSING` and `SOURCE_GAP` are unknown, are excluded from the return
distribution, and are reported beside it.

`NULL` is not `UNKNOWN`. One says nobody has looked; the other says somebody
looked and could not tell. A row predating the classifier is NULL and stays
NULL.

## Reading the output

A group where everything was unobserved prints a **dash**, not `0%`. A printed
zero would be indistinguishable from a real median of zero, which is the
difference between "we do not know" and "it was flat".

```
columns: n, vanished, unobserved, p25, median, p75, up%, doubled%
```

`vanished` is confirmed worthless. `unobserved` is the count excluded. A panel
that says `n=400, 120 unobserved` is honest; one that says `n=400, median −100%`
is not.

## Do not anchor from a future price

When the rejection-time price is missing, the return is not computed from the
first *later* price. That would measure a window chosen by the data's own gaps —
and the gaps are not random, because a provider is likeliest to go quiet exactly
when a token is collapsing.

## Current state

811,977 rows. Classification began at 15:44 on 2026-08-13 and has run
continuously since, covering 29,337 rows. The remaining 785,037 predate the
classifier and are correctly NULL.

`EXECUTABLE_VALUE` is zero across every rejection reason in the classified
sample. That sample is hours old and is not yet a statement about the gates.
