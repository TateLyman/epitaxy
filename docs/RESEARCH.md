# RESEARCH

All facts below were verified against live endpoints or current official docs on
**2026-08-11**. Anything not verified on that date is marked as such. The seed
prompt is treated as a specification of intent, not as a source of current API
truth; where the two conflicted, the live check won.

## Jupiter

**Base URL: `https://api.jup.ag`** — verified live.

`lite-api.jup.ag` is a trap. It still answers `/tokens/v2/recent`, but
`/swap/v2/order` on that host returns `"Route not found"`, and the host is being
retired per Jupiter's own migration guide. A system built on it would appear to
work in discovery and fail silently at the only step that matters. The code
hard-codes `api.jup.ag` and never falls back.

### Rate reality (keyless)

0.5 RPS / 30 RPM, **shared across Swap + Price + Token**. This is the binding
constraint on the entire design:

- One round-trip cost measurement = 2 requests (buy + reverse sell).
- Therefore ≤ ~14 candidates per minute can ever be fully evaluated.
- Therefore anything rejectable for free **must** be rejected for free.

That single number is why `gates.ts` is split into a cheap layer and a quote
layer, and why the collector ranks survivors before spending the budget.
Configured at 0.4 RPS (`config/source-limits.json`) to stay under the documented
ceiling rather than at it.

### Endpoints in use

| Endpoint | Purpose | Notes |
| --- | --- | --- |
| `GET /tokens/v2/recent` | new-launch feed | first-pool-created only; 30 items |
| `GET /tokens/v2/{toptrending,toporganicscore}/5m` | ranked feeds | rotated one per cycle |
| `GET /tokens/v2/search?query=…` | maturation re-fetch | ≤100 mints per call |
| `GET /price/v3?ids=…` | price | ≤50 mints per call |
| `GET /swap/v2/order` | quote | **`taker` deliberately omitted** |

Omitting `taker` means the response's `transaction` field is `null` and no
signable payload can ever reach an observe- or paper-mode process. This is a
structural guarantee, not a policy one.

### Schema notes

- u64 values arrive as **decimal strings**. Parsing them as JS numbers loses
  precision above 2^53. `U64String` enforces `/^\d+$/` and everything downstream
  is `bigint`.
- `priceImpactPct` and `swapType` are deprecated upstream; `priceImpact` and
  `router` are current. Both are accepted, current preferred.
- `transaction` is `null` for quote-only requests but `""` when a build *failed*
  — different meanings, so `transactionBuildable` checks length, not nullness.
- Schemas are `passthrough()`: providers add fields routinely and that must not
  break us. A **missing or retyped** field we depend on fails closed.

### Open discrepancy — new-token fee

Jupiter documents a **50 bps** fee on tokens under 24 hours old. Every live
quote measured returned **`feeBps: 10`**, including on a token created seconds
earlier and on a 52-minute-old token, both routed `metis` → `Pump.fun Amm`.

Candidate explanations, none confirmed:
1. the published fee table is stale;
2. the surcharge applies only on `taker`-bound execution, which we never request;
3. the surcharge is Metis-specific and applied at a stage we don't observe.

Resolution: `assumedNewTokenFeeBps` is set to **50**, the worse case. The
measured 10 bps is recorded as an observation, not adopted as an assumption.
Adopting the cheaper number would make every downstream profitability estimate
optimistic in exactly the way that destroys accounts.

## Solana RPC

| Provider | Free tier | Verified |
| --- | --- | --- |
| Helius | 1M credits/mo, 10 req/s RPC, 2 req/s DAS, WSS (5 concurrent) | 2026-08-11 |
| Solana Labs public | 100 req/10s per IP | 2026-08-11 |
| Ankr | **403** — no longer free for Solana | 2026-08-11 |
| dRPC | **400** — no longer free for Solana | 2026-08-11 |

**Helius does not support `blockSubscribe`.** Use `logsSubscribe`,
`programSubscribe`, or `slotSubscribe`. A design that assumed `blockSubscribe`
would fail only at runtime, under load.

## Token-2022

The extension discriminant `PermissionedBurn` (**28**) exists in the Rust
interface but is **missing from the solana.com documentation**. A fail-closed
decoder written from the docs alone would reject valid mints. The decoder
accepts 0–28 and fails closed at ≥29.

## Clock

Local clock checked against an authoritative `Date` header (api.dexscreener.com)
rather than a Solana RPC host, because the RPC endpoints tested returned no
`Date` header. Skew was within tolerance; `maxClockSkewMs` is 2000.
