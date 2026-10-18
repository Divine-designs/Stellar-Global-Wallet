# Prices (#55, #56, #57)

All price routes are public (no auth) and return USD values as decimal
**strings**. Assets are identified as `XLM` (or `native`) or `CODE:ISSUER`
— a bare code such as `USDC` is rejected, because codes are not unique on
Stellar. Full schemas: [`openapi-prices-assets.yaml`](./openapi-prices-assets.yaml).

## Spot price — `GET /api/v1/price/:asset`

```json
{ "asset": "XLM", "price": "0.1132", "currency": "USD", "source": "stellar_dex", "updatedAt": "2026-10-18T09:00:00.000Z" }
```

Providers are tried in `PRICE_PROVIDERS` order (default `stellar_dex,coingecko`):

| Source | How | Prices |
|---|---|---|
| `stellar_dex` | Mid of the top bid/ask of the `asset / USDC` Horizon orderbook. Both sides must exist and the spread must be ≤ 25 %. The USDC quote asset itself is `1`. | Anything with a direct USDC market |
| `coingecko` | `/simple/price`, one request per batch. | XLM, and verified assets (#54) that have a `coingeckoId` |
| `unavailable` | No provider could price it: `price: null`, `updatedAt: null`. A price is never invented for an illiquid asset. | — |

Failures fall through: a provider that errors or times out is skipped and
the next one is tried. On a CoinGecko 429 the provider backs off for the
`Retry-After` period (or 60 s) and assets it would have priced come back
from the remaining providers or as `unavailable`.

Results (including `unavailable`) are cached in-process for
`PRICE_CACHE_TTL_SECONDS` (default 30 s); concurrent requests for the same
uncached asset share one upstream lookup. `PriceService.invalidate()`
drops entries explicitly.

The USD quote asset is `PRICE_USDC_ISSUER` if set, otherwise the verified
asset with `usdPeg: true` for `STELLAR_NETWORK` (Circle USDC).

## Batch — `GET /api/v1/price?assets=XLM,USDC:GA5Z...`

- At most **50** entries; more is a `400 VALIDATION_ERROR`.
- Any malformed entry fails the whole request (deny-by-default); the
  error `details` name each bad entry as `assets[i]`.
- Duplicates (including `XLM` vs `native`) are collapsed; `prices` is in
  first-occurrence order.
- Shares the spot cache; all misses go to each provider in one call
  (Horizon orderbook lookups run 8 at a time).

```json
{ "currency": "USD", "prices": [ { "asset": "XLM", "price": "0.1132", ... }, { "asset": "USDC:GA5Z...", "price": "1", ... } ] }
```

## History — `GET /api/v1/price/:asset/history?range=7d`

Built from Horizon `/trade_aggregations` for `asset / USDC`.

| `range` | Horizon resolution | Point spacing | Points | Cache TTL |
|---|---|---|---|---|
| `24h` | 1h | 1h | 24 | 1 min |
| `7d` (default) | 1h | 1h | 168 | 5 min |
| `30d` | 1h | 4h | 180 | 15 min |
| `1y` | 1d | 2d | 183 | 1 h |

Points are on a fixed, epoch-aligned grid; `t` is the start of each
interval and the newest point covers the interval in progress. Each point
is the close of the last trade bucket inside its interval.

**Gaps in trading:**

- An interval with no trades **carries forward** the previous price and
  has `filled: true`.
- Intervals before the first trade in the window have `price: null`
  (we don't look back before the window to seed them).
- If there were no trades at all, every point is `null` and `source` is
  `unavailable`.

Horizon errors return `502 PRICE_HISTORY_UNAVAILABLE` (`retryable: true`).

## Not covered yet

- Assets without a direct USDC market on the DEX are not routed via XLM
  (e.g. `TOKEN/XLM × XLM/USDC`) for spot or history; they rely on
  CoinGecko for spot and have no history.
- History has no CoinGecko fallback (`/coins/{id}/market_chart`), so XLM
  history on testnet depends on testnet DEX activity.
- The cache is per process; multiple instances each keep their own.
