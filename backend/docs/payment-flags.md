# Suspicious payment flags (#105)

`GET /api/v1/account/:publicKey/payments` returns the same activity feed as
`GET /api/v1/account/:publicKey/transactions`, but sourced from Horizon's
`/payments` endpoint (so each item carries `amount`/`asset_*`/`from`/`to`)
and with a `flags: string[]` array per item. These are heuristics for the UI
to hide or de-emphasize noise — not proof of abuse.

## Flags

| Flag | Meaning | Threshold |
| --- | --- | --- |
| `dust` | The payment amount is below a configurable floor, in the payment's own asset units. | `SPAM_DUST_THRESHOLD` (default `0.5`) |
| `memo_url` | The transaction memo contains a URL (`http://`, `https://`, or a bare `www.` host) — a common phishing pattern ("claim your reward at ..."). | n/a |
| `unknown_asset` | The payment's asset is not native XLM and not on the verified-asset allow-list. | Curated list in `data/verified-assets.<network>.json` ([verified-assets.md](./verified-assets.md)) plus `VERIFIED_ASSETS` additions |

Implementation: [`src/services/paymentFlags.ts`](../src/services/paymentFlags.ts).
Wired into [`StellarService.getPaymentHistory`](../src/services/stellar.ts).

## Known limitations

- `dust` compares the threshold directly against the payment's own asset
  amount. It does **not** convert to a common unit (e.g. USD) across
  assets, since that needs a price feed per asset (out of scope here — see
  [#54](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/54)).
  For typical dust spam (sending a tiny amount of whatever's cheapest to
  acquire) a flat per-asset threshold still catches it; it may misfire for
  a deliberately small payment in a high-value asset.
- `unknown_asset` only evaluates assets that actually appear on a `payment`-
  or `path_payment_*`-type operation. Operation types without a single
  amount+asset (e.g. `create_account`, `account_merge`) are included in the
  feed but never get `dust`/`unknown_asset` (there's nothing to evaluate).
- The allow-list is the maintainer-reviewed list from
  [#54](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/54)
  (see [verified-assets.md](./verified-assets.md)). `VERIFIED_ASSETS`
  (`"CODE:ISSUER,..."`) can add per-deployment entries on top of it, but
  cannot remove curated ones.

## Configuration

See `.env.example`:

```
SPAM_DUST_THRESHOLD=0.5
VERIFIED_ASSETS=
```
