# Transaction history, detail and fiat prices

Covers `GET /api/v1/account/:publicKey/history` (#59, #61),
`GET /api/v1/transactions/:hash` (#60) and `?currency=` on price routes (#58).
Full request/response schemas are in [openapi.yaml](./openapi.yaml).

## History items (#59)

`/history` reads Horizon's `/accounts/:id/operations` with
`join=transactions` (memo, fee and op count come back in the same request)
and `include_failed=true` (failed transactions appear with
`successful: false`). Each operation becomes one `HistoryItem`, described
from the viewing account's point of view:

| Horizon op type | `type` | `direction` | `amount` / `asset` | `counterparty` |
|---|---|---|---|---|
| `payment` | `payment` | `out` if account is `from`, `in` if `to`, `self` if both | payment amount/asset | the other side |
| `path_payment_*` (from ≠ to) | `payment` | as above | **out:** `source_amount`/source asset; **in:** destination amount/asset. Both sides are also in `sourceAmount`/`sourceAsset` + `amount`/`asset` | the other side |
| `path_payment_*` (from = to = account) | `swap` | `self` | received amount/asset; spent side in `sourceAmount`/`sourceAsset` | `null` |
| `create_account` | `account_created` | `out` if account funded it, `in` if it was created | `starting_balance` XLM | the other side |
| `change_trust` | `trustline` | `self` | `asset` = trusted asset, `amount` null; `trustlineLimit` set (`"0.0000000"` = removed) | `null` |
| `invoke_host_function` | `contract` | from the first `asset_balance_changes` entry touching the account; `self` if none | that change's amount/asset | other party of that change, else the contract |
| `account_merge` | `other` | `out` if merged away, `in` if merged into | XLM (amount isn't on the op record) | the other side |
| anything else | `other` | `self` if the account is the op source, else `in` | if the op carries one (e.g. claimable balances) | op source, if not the account |

**Multi-op transactions** produce one item per operation. `memo`, `fee`,
`feePayer` and `transactionOperationCount` describe the parent transaction
and are repeated on each of its items; `fee` is the XLM charged for the
whole transaction, so a client should show it once and only when
`feePayer` is the viewing account.

All amounts are decimal strings as Horizon returns them (7 dp). `fee` is
converted from stroops without floating point.

The existing `/transactions` (transaction summaries) and `/payments`
(suspicious-payment flags, #105) endpoints are unchanged.

## Filters (#61)

| Param | Format | Notes |
|---|---|---|
| `asset` | `XLM`, `CODE`, or `CODE:ISSUER`; comma-separated, max 10 | `CODE` alone matches any issuer, so it also matches look-alike assets — use `CODE:ISSUER` when the issuer is known. Matches either side of an item (`asset=USDC` includes XLM→USDC swaps). |
| `type` | comma-separated item types | `payment,swap,trustline,account_created,contract,other` |
| `direction` | comma-separated `in,out,self` | |
| `since` | ISO 8601 | inclusive |
| `until` | ISO 8601 | exclusive; must be later than `since` |

"All USDC payments last month" →
`?asset=USDC:G…&type=payment&since=2026-09-01T00:00:00Z&until=2026-10-01T00:00:00Z`.

### Limitations

Horizon can't filter operations by asset, type or date server-side. With any
filter set, the API scans the account's operations newest-first, 200 per
Horizon request, and stops when:

1. `limit` matches are collected → `hasMore: true`, `next` set;
2. history runs out → `hasMore: false`;
3. it reaches an operation older than `since` → `hasMore: false` (results
   are newest-first, so nothing older can match — a tight `since` keeps
   scans cheap);
4. it has examined `HISTORY_SCAN_CAP` operations (default 1000, max 10000)
   → `scanCapped: true`, `hasMore: true`, `next` set.

On a very active account a narrow filter can therefore return fewer than
`limit` items — even zero — with `scanCapped: true`. That is not the end of
the results: follow `next` (same filters) to keep scanning. `scanned` reports
how many operations were examined. `until` doesn't speed anything up: newer
operations still have to be read and skipped.

`next` is always the paging token of the last operation *examined*, so
stopping mid-page never skips or repeats records, and filtered pages chain
with cursor pagination the same way unfiltered ones do. Changing filters
between pages with the same cursor is allowed but means the earlier pages
used different criteria.

## Transaction detail (#60)

`GET /api/v1/transactions/:hash` returns the transaction (ledger, time,
status, fee/max fee in XLM, memo) with every operation decoded as a
`HistoryItem` and a `explorerUrl` of the form
`https://stellar.expert/explorer/{public|testnet}/tx/{hash}`, chosen from
`NETWORK_PASSPHRASE` (`null` on futurenet/standalone, which stellar.expert
doesn't index).

Operation `direction`/`counterparty` need a point of view: pass
`?account=G…` (usually the signed-in user); it defaults to the transaction's
source account.

| Case | Status | `code` |
|---|---|---|
| hash isn't 64 hex chars, or `account` isn't a valid address | 400 | `VALIDATION_ERROR` |
| unknown hash on this network | 404 | `TRANSACTION_NOT_FOUND` |

## Fiat currency (#58)

`GET /api/v1/price/:asset?currency=NGN` adds `currency`, `price` (in that
currency) and an `fx` quote (`rate` = units per 1 USD, `source`,
`updatedAt`, `stale`). `price_usd` is unchanged. `currency` is
case-insensitive and defaults to `USD` (which never hits the network).
`GET /api/v1/price/currencies` lists the accepted codes.

- **Source:** `FX_API_URL` (default `https://open.er-api.com/v6/latest/USD`,
  free, no key, covers NGN/KES/GHS/BRL etc. which the ECB feed does not).
  Any replacement must return the same JSON shape.
- **Caching:** in-process, `FX_CACHE_TTL_MS` (default 1h); concurrent misses
  share one upstream request. If a refresh fails, the previous rates are
  served with `stale: true`; with nothing cached the response is
  `503 FX_UNAVAILABLE` (`retryable: true`).
- **Errors:** an unsupported currency → `400 UNSUPPORTED_CURRENCY` with
  `details: { currency, supported: [...] }`. Messages come from
  `packages/i18n/errors/en.json` with ICU placeholders.
- `price` is display precision (2 dp ≥ 1, else 7 dp) — never use it for
  settlement. The price oracle itself is still a placeholder, so `price` and
  `price_usd` are `null` until one is connected.
