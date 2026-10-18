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
