# PumpSwap parity, v3

`packages/research/src/capability-fingerprint.ts` · `pnpm pumpswap:parity-v3`
→ `artifacts/pumpswap-parity-v3.json` · `artifacts/landed-parity-v2.json`

## What makes this v3

**Parity is reported per capability fingerprint, not per program id.**

v2 answered "does Epitaxy agree with the SDK on PumpSwap". That is a question
about a program id, and the answer generalised across every instrument sharing
it. A Token-2022 base mint carrying a transfer hook, at a different fee-config
hash, built by a different SDK version, is a **different instrument** — one
agreement said nothing about it.

v3 refuses to emit a global "PumpSwap parity: true".

## What the fingerprint binds

```
venue program id · programdata hash · pool layout version
instruction discriminator · fee-config hash
cashback flag · cashback accounts present · Mayhem flag
base/quote token programs · token extensions · quote mint
builder version · runtime version
```

Field names are hashed alongside values, so **adding a dimension changes every
fingerprint**. That is correct: a new dimension means the old ones no longer
fully describe the instrument, and silently keeping old approvals valid would
carry an approval across a change nobody reviewed.

An absent dimension hashes as absent, not as a wildcard. An unbound dimension
means the fingerprint does not pin it, so an approval covers **less** than it
appears to.

## Required parity per approved fingerprint

```
OFFICIAL_SDK_QUOTE · EPITAXY_LOCAL_QUOTE · DIRECT_INSTRUCTION_SIMULATION
SEQUENTIAL_RUNTIME_EFFECT · LANDED_DIRECT_SWAP
```

`LANDED_DIRECT_SWAP` may be absent **only** when attribution is not isolatable. A
landed transaction routed through an aggregator cannot attribute its fill to one
venue, and pretending it can is worse than not having the check. Absence is
recorded; it is never treated as agreement.

## A narrow reviewed fingerprint may be approved before global parity

That is the point of binding this tightly. Approving one exactly-described
instrument is honest. Approving "PumpSwap" is a claim about instruments nobody
has measured.

## Historical config bytes

`assertConfigUsableForHistorical` throws unless the config hash is **proven
unchanged** over the interval, or the config is included in the
transaction/event evidence. A fee decoded from the wrong table is a confident
wrong number rather than a missing one.

## Current standing

One fingerprint is approved: canonical PumpSwap, legacy Token both sides, WSOL
quote, non-cashback, non-Mayhem, through the sequential runtime. Four of four
applicable checks agree.

**Landed parity covers 3 of 12 required dimensions.** Missing: wrapped quote,
cashback, noncashback, legacy token, Token-2022, multiple sizes, multiple pools,
current programdata hash, current fee-config hash.

Landed attribution is **not** isolatable today — every buy routes through
Jupiter. That is the work, not a formatting gap, and the artifact names each
missing dimension rather than omitting them.

Five of the fingerprint's fourteen dimensions are currently unbound
(`programDataHash`, `instructionDiscriminator`, `feeConfigHash`, and others).
The approval is correspondingly narrow and must not be widened by assumption.
