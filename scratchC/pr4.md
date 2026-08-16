The SDK **chooses** things. It selects a fee recipient from a list, appends remaining accounts when cashback applies, and derives associated token accounts under whichever token program the mint uses. Two builds of "the same" leg are not guaranteed to be the same transaction, and a system that captures state for one build, simulates a second and fingerprints a third is comparing three experiments while reporting one.

## The plan

Frozen from the same instruction array that gets encoded — not a rebuild, not a re-derivation. It carries ordered account metas, instruction data and every program invoked. **Position is part of the identity**, because PumpSwap reads the cashback accumulator ATA at remaining index 0: *present* and *present in the right place* are different facts.

## What checking it against the snapshot found

The snapshot was assembled from `swapAccountAddresses`, which **re-derives** what it believes the leg will use. On live pools the built instruction touched **fifteen accounts derivation never predicted**.

None of them would have failed loudly. An account absent from the runtime executes as uninitialised and answers with an error that reads as a fact about the token.

They are fetched now rather than guessed at a second time. This is a second *read*, not a second *capture* — the coherent snapshot's price-bearing accounts are untouched and only accounts the plan named are added. Those are fee recipients, ATAs and programs, none of which bear price, which is the same boundary the drift bound already draws. Executables go back through the program path, because an executable restored with `set_account` populates no program cache and every route through it then fails with an invalid-program error.

An account still missing after the fetch **does not exist on chain**. That is a fact, not a failure: the transaction is about to create it, and the creation is exactly the cold-setup cost P6 exists to measure. Recorded as incompleteness rather than refused.

## F11 — the fee config that degraded silently

Three call sites caught a decode failure and substituted `null`. *No dynamic fee config exists* and *the config exists and this build cannot read it* are opposite facts, and `null` merges them into the first — the pricing that follows is computed against the static tier while the chain charges the dynamic one. All three refuse now.

## Append-only

Recording the same plan twice is a retry. Recording a **different** plan under the same identity is a rebuild, and letting it through would redefine what the earlier execution was, after the fact and without a trace.

## Evidence

A real plan, persisted from a live open:

```
leg buy | instructions 6 | fingerprint a7710c585ad0
programs : ATokenGPvbdG…, 1111…1111, TokenkegQfeZ…, pAMMBay6oceH…
accounts : 26, of which writable 10
```

The collector opened two trajectories with the check live, and the acquired amounts are **identical** to before the extra accounts were fetched — the fetch changed the apparatus, not the mechanics.

```
typecheck   clean
secretscan  clean
tests       1,548 passed, 4 skipped, 108 files  (12 new)
```

Nothing funded, signed or submitted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
