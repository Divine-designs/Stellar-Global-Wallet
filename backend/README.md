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
