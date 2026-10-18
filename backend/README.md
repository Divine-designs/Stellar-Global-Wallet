# Stellar Global Wallet — Backend

API and indexer for the Stellar Global Wallet. The API exposes read endpoints and
unsigned-XDR builders for the wallet contract; the indexer keeps a durable
history of contract events in Postgres so clients are not limited by RPC event
retention (~7 days on testnet).

## Getting started

```bash
git clone https://github.com/Genghis-codes/Stellar-Global-Wallet.git
cd Stellar-Global-Wallet/backend
cp .env.example .env          # testnet defaults + a live demo contract ID
npm install
npm run dev                   # API on http://localhost:4000
npm test                      # Jest suite
npm run type-check
```

The `.env.example` points at a real testnet contract with a demo user, so read
endpoints work without deploying anything.

## Asset discovery and wallet reads

OpenAPI entries for these live in [docs/openapi.yaml](docs/openapi.yaml).
All are unauthenticated reads.

| Route | What it returns |
|---|---|
| `GET /api/v1/assets/search?code=USDC[&limit&cursor]` | Horizon `/assets` page for the code; verified issuers first, then by trustline count (#53) |
| `GET /api/v1/assets/search?domain=circle.com` | Assets the domain's stellar.toml lists whose issuer `home_domain` points back at it (#53) |
| `GET /api/v1/assets/{code}/{issuer}` | `name`, `desc`, `image`, `decimals`, `homeDomain`, `orgName` from stellar.toml, plus a `status` (#52) |
| `GET /api/v1/contract/wallet/guardians` | Guardian addresses (#51) |
| `GET /api/v1/contract/wallet/recovery/config` | `{ threshold, delayInLedgers }` or `null` (#51) |
| `GET /api/v1/contract/wallet/recovery/proposal` | Active proposal with approvals vs threshold and timelock ETA, or `null` (#51) |
| `GET /api/v1/contract/wallet/recovery` | All three in one response (#51) |
| `GET /api/v1/contract/wallet/{publicKey}/spend-allowance[/{assetCode}]` | `limit`, `spent`, `remaining`, `windowResetsAt` per asset (#50) |

Notes:

- **Verified assets** come from a small built-in list per network
  (`src/services/verifiedAssets.ts`) plus `VERIFIED_ASSETS`
  (comma-separated `CODE:ISSUER`). The activity feed's `unknown_asset` flag
  reads the same variable.
- **stellar.toml fetches** use https only, a 5s timeout and a 100KB cap,
  and refuse hosts that resolve to private, loopback, link-local or other
  non-public addresses, including on redirects. Results are cached in Redis
  for 24h, or 1h when no metadata was found. A missing or malformed toml
  returns `200` with null fields and a `status`, not an error.
- **Spend windows** follow the contract: `ledger_timestamp / 86400`, so they
  reset at 00:00:00 UTC by ledger close time. See
  [docs/specs/spend-limits.md](../docs/specs/spend-limits.md).
- The spend-allowance routes call the contract's new `get_spend_allowance`
  view. Until the deployed contract is upgraded to include it, they return
  `422 SOROBAN_SIMULATION_FAILED`.

## Contract event indexer

The indexer polls Soroban RPC `getEvents` filtered by the wallet contract ID and
persists every event in Postgres. It is safe to restart at any time: the last
processed ledger is stored in the `indexer_state` table and polling resumes from
that cursor.

### Schema

`contract_events` stores one row per contract event:

| column       | type        | notes                                   |
| ------------ | ----------- | --------------------------------------- |
| `id`         | text PK     | RPC event id; unique, used for dedupe   |
| `ledger`     | bigint      | ledger sequence the event was emitted in |
| `tx_hash`    | text        | transaction hash                        |
| `type`       | text        | normalised event type                   |
| `topics`     | jsonb       | raw topics array                        |
| `data`       | jsonb       | raw event value                         |
| `created_at` | timestamptz | insert time                             |

Inserts use `ON CONFLICT (id) DO NOTHING`, so re-processing a ledger range never
creates duplicate rows.

`indexer_state` holds the polling cursor (last processed ledger) so the worker
resumes where it left off after a restart.

### Running the worker

```bash
npm run indexer          # start the polling worker
```

### Backfill

To index historical events from a given ledger:

```bash
npm run indexer:backfill -- --from-ledger N
```

The backfill walks ledgers forward from `N`, writing events with the same
duplicate-safe insert used by the live worker.

### Retention gaps

If the worker is down longer than the RPC retention window, events older than
the cursor may no longer be available from RPC. The worker logs an alert when it
detects that the requested start ledger is older than the RPC's earliest
available ledger; run the backfill command against an archive RPC in that case.
