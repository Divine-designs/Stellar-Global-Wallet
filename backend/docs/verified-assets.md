# Verified assets (#54)

**Threat.** Anyone can issue an asset with the code `USDC` from their own
account and send it to users, hoping it is mistaken for Circle's USDC (to
get it "sold", accepted as payment, or used as bait for a phishing memo).
Asset codes are not unique on Stellar; only `code + issuer` is. Today a
client has no reviewed source to tell the real issuer from a lookalike.

**Defence.** A small allowlist, reviewed by a maintainer, that the apps use
to badge genuine assets and warn on everything else:

- `backend/data/verified-assets.testnet.json`
- `backend/data/verified-assets.mainnet.json`

The file for `STELLAR_NETWORK` is served at `GET /api/v1/assets/verified`
(public, `Cache-Control: max-age=300`) and also feeds the
`unknown_asset` payment flag ([payment-flags.md](./payment-flags.md)) and
which assets may be priced via CoinGecko ([prices.md](./prices.md)).

```json
{ "network": "mainnet", "assets": [ { "code": "USDC", "issuer": "GA5Z...KZVN", "domain": "centre.io", "name": "USD Coin" } ] }
```

Native XLM is always trusted and is not listed.

## Changing the list

1. Open a PR editing the JSON file. `.github/CODEOWNERS` requires a
   maintainer review for these files.
2. Verify the issuer against the asset's `stellar.toml` on `domain`
   (`https://<domain>/.well-known/stellar.toml`, `[[CURRENCIES]]`).
3. Entry fields: `code`, `issuer`, `domain`, `name` are required;
   `coingeckoId` (enables CoinGecko pricing) and `usdPeg` (the DEX USD
   quote asset — at most one) are optional.

The file is validated strictly when the API starts: unknown fields, a
malformed code or domain, an issuer that fails the StrKey checksum, a
duplicate entry or a `network` mismatch stop the process from booting
rather than serving a partly-trusted list.
