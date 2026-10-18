# Performance baseline: read endpoints (#122)

Before the web/mobile apps launch and start polling this API continuously,
we want a known capacity baseline for the endpoints they'll hit most:
account overview, balances, and activity-feed history (transactions and the
flagged payments feed from #105). Price is included too, even though it's
currently a placeholder with no upstream I/O (see
[`load-tests/price.js`](../load-tests/price.js)).

k6 scripts for all four live in [`load-tests/`](../load-tests); see that
directory's README for how to run them.

## Baseline numbers

**Not yet captured.** The scripts are runnable locally (`load-tests/README.md`
has the exact commands) and that's what #122's acceptance criteria asks
for — the numbers below need to come from a real run against a running
instance (ideally the preview deployment from #110 once it exists, or a
local server backed by something other than the shared public testnet
Horizon — see the load-tests README's caveat on why that matters), which
wasn't done as part of adding the scripts themselves. Whoever runs the
first baseline, please fill in this table and replace this paragraph.

| Endpoint | p50 | p95 | Error rate | VUs | Notes |
| --- | --- | --- | --- | --- | --- |
| `GET /account/:publicKey` | — | — | — | — | |
| `GET /account/:publicKey/balances` | — | — | — | — | |
| `GET /account/:publicKey/transactions` | — | — | — | — | |
| `GET /account/:publicKey/payments` | — | — | — | — | |
| `GET /price/:asset` | — | — | — | — | cached 30 s; misses hit Horizon orderbook / CoinGecko |
| `GET /price?assets=…` (batch, up to 50) | — | — | — | — | shares the spot cache; misses batched per provider |

## Thresholds used by the scripts

Default thresholds (overridable per run, see `load-tests/config.js`):

- Horizon-backed endpoints (overview, balances, history): p50 < 300ms, p95 < 800ms, error rate < 1%.
- `price` (mostly cache hits after warm-up): p50 < 100ms, p95 < 300ms, error rate < 1%.

These are starting points, not measured targets — tighten or loosen them
once the baseline above is filled in.
