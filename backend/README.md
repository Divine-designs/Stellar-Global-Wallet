# Backend API

Express + TypeScript API for the Stellar Global Wallet.

## Getting started

```bash
cp .env.example .env          # testnet defaults + a live demo contract ID
npm install
npm run dev     # API on http://localhost:4000
npm test
npm run type-check
```

## API documentation

The OpenAPI 3.1 contract lives in [`openapi.yaml`](./openapi.yaml). When the docs
are enabled, the server serves:

- **Interactive docs** — `GET /api/docs` (Swagger UI, backed by the spec below)
- **Raw spec** — `GET /api/openapi.json` (the YAML converted to JSON once at startup)

Docs are gated by the `ENABLE_API_DOCS` environment variable:

| `ENABLE_API_DOCS` | `NODE_ENV`  | Docs served |
| ----------------- | ----------- | ----------- |
| unset             | production  | no (404)    |
| unset             | anything else | yes       |
| `true`            | any         | yes         |
| `false`           | any         | no (404)    |

So a production build does **not** expose the docs by default; set
`ENABLE_API_DOCS=true` to opt in. When disabled, both routes return `404`.

Helmet's default Content-Security-Policy blocks the inline scripts Swagger UI
needs, so the docs routes get a route-specific CSP that allows them. The rest of
the API keeps the strict default policy.

The routes that let a wallet sign for itself (`/wallet/send/build`,
`/wallet/submit`, the path payment `/build` routes and the Soroban
`/contract/wallet/spend/build` + `/contract/wallet/submit`) are described in
[`docs/openapi-client-signing.yaml`](./docs/openapi-client-signing.yaml) and
walked through in [`docs/client-signing.md`](./docs/client-signing.md).

## Tests

```bash
npm test
```

Route tests use [supertest](https://github.com/ladjs/supertest) and cover the
happy path, validation failures and auth failures. Schema-conformance tests
check responses against `openapi.yaml`.

## Client runtime configuration

`GET /api/v1/config` is public and returns the configured Stellar network,
network passphrase, Horizon and Soroban RPC URLs, available contract IDs,
feature availability, and API/client versions. The response is cached for
60 seconds. Contract IDs are `null` when that contract is not configured;
the endpoint never serializes the complete server configuration or secrets.

## Trustlines and wallet asset registry

- `POST /api/v1/wallet/trustline/build` returns unsigned `changeTrust` XDR.
  Omit `limit` to use the maximum Stellar trustline limit; pass `"0"` to
  remove a trustline. Removal requires an existing trustline with zero
  balance. The response reports `reserveDelta` and `spendableXlmAfter`;
  removing a sponsored trustline can have a zero reserve impact for the
  account because the sponsor supplied the reserve.
- `POST /api/v1/contract/wallet/assets/build` and
  `POST /api/v1/contract/wallet/assets/remove/build` build unsigned Soroban
  transactions for the wallet's asset registry. `AssetInfo` has a 1–12
  character alphanumeric `code` and an `issuer`; native XLM uses `issuer:
  null`. Removal is rejected while that asset has a configured spend limit.

These endpoints only build transactions. The client must show the reserve
change (an unsponsored trustline addition locks 0.5 XLM), obtain the user's
signature through their wallet, and use a supported submission flow.

Failures use the shared error envelope and stable `error.code` values:
`INSUFFICIENT_RESERVE` and `ASSET_ISSUER_NOT_FOUND` for trustline additions,
`TRUSTLINE_NOT_FOUND` and `TRUSTLINE_HAS_BALANCE` for trustline removal,
`ASSET_ALREADY_ADDED` for duplicate wallet assets, and
`ASSET_HAS_ACTIVE_SPEND_LIMIT` when a wallet asset still has a spend limit.

## Legacy secret-key route migration

The legacy routes below emit `Deprecation`, `Sunset`, and `Link` headers and
write a structured warning containing the route and request ID. The sunset is
January 1, 2027. They continue to work until removal, but clients should stop
sending secret keys to the API. A caller that can observe request bodies in
transit, application logs, telemetry, or a compromised backend process could
use an exposed key to sign transactions and move the account's funds.

| Legacy route | Migration |
| --- | --- |
| `POST /api/v1/wallet/send` | Use a wallet-native signing flow. The unsigned payment build/submit equivalent is not part of this change. |
| `POST /api/v1/wallet/partial-transaction` | Stop sending source secret keys; use client-side signing when a build endpoint is available for the operation. |
| `POST /api/v1/wallet/fee-bump` | Do not send a fee-source secret key; no fee-bump build/submit replacement is included here. |
| `POST /api/v1/wallet/path-payment-strict-send` and `...strict-receive` | Do not send a source secret key; use a client-side signed path-payment flow when available. |
| `POST /api/v1/contract/wallet/spend` | Use the unsigned `record_spend` build/submit flow when available; it is not part of this change. |
| `POST /api/v1/wallet/keypair` | Generate and protect keys in the user's wallet; the server must not be the source of a user's secret key. |

The deprecation headers are additive. Authentication and validation behavior
otherwise remain unchanged.
