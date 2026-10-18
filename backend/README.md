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

## Exploring the API with Postman

A Postman collection generated from [docs/openapi.yaml](docs/openapi.yaml) lives
at [docs/globe-wallet.postman_collection.json](docs/globe-wallet.postman_collection.json).
It lets you explore endpoints without a UI and has the auth flow pre-wired.

1. Import `docs/globe-wallet.postman_collection.json` into Postman.
2. Set the `baseUrl` collection variable (defaults to `http://localhost:4000`)
   and fill in `email` / `password` — no secrets are stored in the file.
3. Run **Auth / Login** first. Its test script stores the returned bearer token
   in the `token` collection variable, which every other request uses.
4. Run any other request; the collection-level pre-request script warns if the
   token is missing.

To regenerate the collection after changing the spec:

```bash
npx openapi-to-postmanv2 -s docs/openapi.yaml -o docs/globe-wallet.postman_collection.json -p
```

## Send flow & statements

OpenAPI: [docs/openapi.yaml](docs/openapi.yaml). All routes below need a bearer
JWT; amounts are decimal strings (max 7 places), never JSON numbers.

- **`POST /api/v1/wallet/send/precheck`** (#64) — read-only check before
  signing. Body `{ sourcePublicKey, destinationPublicKey, amount, asset?, memo? }`
  returns `{ warnings: [{ code, message, blocking }], blocking, operationType, spendable? }`.
  Warning codes: `DESTINATION_IS_SOURCE`, `SOURCE_NOT_FUNDED`,
  `DESTINATION_NOT_FUNDED`, `DESTINATION_WILL_BE_CREATED`, `NO_TRUSTLINE`,
  `TRUSTLINE_NOT_AUTHORIZED`, `MEMO_REQUIRED` (SEP-29),
  `AMOUNT_EXCEEDS_SPENDABLE`. Don't offer "Sign" while `blocking` is true.
- **Unfunded destinations** (#65) — `POST /wallet/send` and
  `POST /wallet/partial-transaction` automatically use `createAccount`
  instead of `payment` when the destination doesn't exist, the asset is XLM
  and the amount is at least 1 XLM. Any other send to an unfunded account
  fails with `400 DESTINATION_NOT_FUNDED` (`details.reason`:
  `NON_NATIVE_ASSET` or `BELOW_MINIMUM_STARTING_BALANCE`) before signing.
  `partial-transaction` also returns `operationType`.
- **`GET /api/v1/resolve?q=`** (#63) — resolves `G...` (as-is), `M...` muxed
  addresses (`accountId` + `muxedId`) and SEP-2 federation addresses
  (`alice*example.com` → `accountId`, plus `memo`/`memoType` if the server
  returns one). Federation lookups time out after 3s (`504 FEDERATION_TIMEOUT`);
  unknown names are `404 FEDERATION_NOT_FOUND`; a domain without a working
  federation server is `502 FEDERATION_UNAVAILABLE`.
- **`GET /api/v1/account/:publicKey/transactions/export.csv?from=&to=`** (#62)
  — streams a CSV statement (`date,type,direction,amount,asset,counterparty,memo,fee,hash`).
  `from`/`to` are ISO-8601, default to the last 365 days, max range 366 days
  (`400 EXPORT_RANGE_TOO_LARGE`). Cells starting with `= + - @` are prefixed
  with `'` to block spreadsheet formula injection.

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
