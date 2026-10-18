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

## Transaction history & prices

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/account/:publicKey/history` | Display-ready, operation-level history (direction, counterparty, asset, memo, fee, status). Filters: `asset`, `type`, `direction`, `since`, `until`. |
| `GET /api/v1/transactions/:hash` | One transaction with decoded operations and a stellar.expert link. |
| `GET /api/v1/price/:asset?currency=NGN` | Price with FX conversion to a local currency (cached 1h). |
| `GET /api/v1/price/currencies` | Currencies accepted by `?currency=`. |

Horizon can't filter by asset/type/date, so filtered history requests scan up to
`HISTORY_SCAN_CAP` operations and may return `scanCapped: true` with fewer items
than `limit` — keep following `next`. Details and limitations:
[docs/transaction-history.md](docs/transaction-history.md); schemas:
[docs/openapi.yaml](docs/openapi.yaml).

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
