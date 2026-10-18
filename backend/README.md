# Backend

Express + TypeScript API for the Stellar Global Wallet.

## API versioning

The API is versioned in the URL (`/api/v1`) and every response carries an
`X-API-Version` header. See [docs/versioning.md](docs/versioning.md) for the
full policy on breaking vs. non-breaking changes and the deprecation window.

## Getting started

```bash
cp .env.example .env
npm install
npm run dev     # API on http://localhost:4000
npm test
npm run type-check
```

## Mock API server

Frontend work can start before every endpoint is live by mocking from the
OpenAPI spec. The mock server is driven by `docs/openapi.yaml` and serves the
realistic `examples` defined for each schema (accounts with XLM + USDC, a
pending recovery, etc.), so responses are typed and predictable.

```bash
npm run mock    # Prism on http://localhost:4010
```

This runs `prism mock docs/openapi.yaml -p 4010 --dynamic=false`, which returns
the static examples from the spec. Point the web/mobile apps at
`http://localhost:4010` to develop offline without testnet flakiness.

### Forcing error examples

Each operation documents error responses (e.g. `429`, `404`, `400`). Use
Prism's `Prefer` header to force a specific response code:

```bash
curl -H 'Prefer: code=429' http://localhost:4010/api/v1/accounts/me
```

This is useful for exercising rate-limit and error UI paths without waiting for
the real backend to fail.
