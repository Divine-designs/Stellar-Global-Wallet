# Soroban RPC integration (issue #21)

## The problem

This service imported `@stellar/stellar-sdk` and talked to Horizon (classic
Stellar payments), but had no Soroban RPC client, no contract ID
configuration, and no code path that ever invoked the `globe-wallet` or
`token-wrapper` contracts in `Orbit-Wal/contract`. The backend and the
on-chain contracts were entirely disconnected — none of globe-wallet's
asset registry, spend limits, or admin/recovery logic was reachable from
this API at all.

## Design

### Two clients, not one

Horizon (`StellarSdk.Horizon.Server`) and Soroban RPC
(`StellarSdk.rpc.Server`) are different protocols with different methods
(`simulateTransaction`/`sendTransaction`/`getTransaction` vs. classic
`submitTransaction`) and, in general, different endpoints. `SorobanService`
(`src/services/soroban.ts`) is a standalone client, configured by its own
env vars (`SOROBAN_RPC_URL`, `SOROBAN_NETWORK_PASSPHRASE`) rather than
reusing `HORIZON_URL`/`NETWORK_PASSPHRASE` — today those happen to be the
same string on testnet, but conflating the two configs would silently break
the day they diverge (e.g. a Soroban RPC provider fronting a different
network endpoint than the Horizon instance).

### Layering: generic RPC mechanics vs. one contract's typed API

- **`src/services/soroban.ts` (`SorobanService`)** — contract-agnostic:
  build an invocation, simulate it, and either return the decoded result
  (read-only path) or assemble + sign + submit + poll (write path). Knows
  nothing about `globe-wallet` specifically.
- **`src/services/contracts/globeWallet.ts` (`GlobeWalletContract`)** —
  encodes/decodes the specific `ScVal` shapes `get_assets` and
  `record_spend` need, and translates that contract's error codes into
  readable messages (`globeWalletErrors.ts`).

This split means adding `token-wrapper` (or another globe-wallet function)
later is a new thin wrapper class over the same `SorobanService`, not a
second copy of the simulate/assemble/sign/submit/poll machinery.

### Simulation-before-submission

Every write path (`SorobanService.invoke`) simulates first and **only**
calls `sendTransaction` if that simulation succeeds. A failed simulation —
bad arguments, a missing `require_auth()` grant, or a contract error like
`SpendLimitExceeded` — throws `SorobanSimulationError` before any fee is
paid or any transaction is submitted. This is verified two ways:

1. **Unit tests** (`tests/services/soroban.test.ts`) assert `sendTransaction`
   is never called when simulation reports an error.
2. **Real testnet run** (below): a `record_spend` call that would exceed
   the caller's daily limit is rejected in ~1.2s with HTTP 422 and no
   transaction hash, vs. ~7s and a real hash for a call that passes
   simulation — the timing difference itself is evidence nothing was
   submitted on the rejected path.

### Read-only calls never pay a fee

`get_assets` only ever calls `SorobanService.simulate`, which never touches
`sendTransaction`/`getTransaction` at all — there's no "submission" step
for a function that doesn't mutate state, so no signing key is required
and no fee is paid, ever, for that route.

### Error mapping

| Thrown from | Meaning | HTTP |
|---|---|---|
| `SorobanNotConfiguredError` | `GLOBE_WALLET_CONTRACT_ID` isn't set | 503 |
| `SorobanSimulationError` | Simulation rejected the call — nothing was submitted | 422 |
| `SorobanTransactionError` | Passed simulation but failed on-chain (rare — state changed between simulate and submit), or never reached a final status before the poll timeout | 502 |

422 (not 500) for a simulation rejection matters: it's a rejected request,
not a server fault — the caller's input (or current on-chain state, e.g.
their remaining spend limit) is why the call didn't go through, and no
money was spent finding that out.

### Contract error translation

`globeWalletErrors.ts` maps a raw `Error(Contract, #N)` string (as returned
by simulation) to the corresponding `WalletError` variant name from
`Orbit-Wal/contract`'s `globe-wallet/src/lib.rs`, e.g. `#1007` →
`SpendLimitExceeded`. This was verified against a **real** rejection (see
below) — the live error text matched the expected format exactly.

### Auth boundary

- `GET /api/v1/contract/wallet/:publicKey/assets` — public, unauthenticated,
  same trust level as the existing `GET /api/v1/account/*` routes: it's a
  read of public on-chain data, and costs nothing to call.
- `POST /api/v1/contract/wallet/spend` — gated by `jwtAuth`, same as
  `POST /api/v1/wallet/send`: it takes a secret key in the body and is a
  fee-paying, state-changing call, so it sits behind the same boundary as
  the existing fund-movement endpoint.

- `POST /api/v1/contract/wallet/spend/build` and
  `POST /api/v1/contract/wallet/submit` — also gated by `jwtAuth`, and the
  non-custodial way to record a spend: build simulates `record_spend` for a
  **public** key and returns the unsigned XDR, the user signs it in their own
  wallet, and submit sends it and polls to a final status. Neither accepts a
  secret key. See [client-signing.md](client-signing.md#soroban-auth-entries-simulation-and-rebuilds).

## A caveat about the contract repo's `WalletError` enum

While validating this against a live deployment, `Orbit-Wal/contract`'s
`main` branch failed to compile: `globe-wallet/src/lib.rs`'s `WalletError`
enum declares `SpendLimitExceeded` and `NoAssetsProvided` twice (once at
`1007`/`1008`, again at `7`/`8` — a merge artifact). `globeWalletErrors.ts`
documents this and mirrors the numbering used in the deployment below
(the duplicate resolved by keeping `1007`/`1008`, dropping `7`/`8`). That
fix was applied **locally only**, to produce a deployable build for this
PR's own end-to-end verification — it was not opened as a change against
`Orbit-Wal/contract`, since that's a different repository with its own
issue/PR process. If that repo resolves the duplicate differently, update
the error map to match.

## Dependency notes

- **`@stellar/stellar-sdk` upgraded `^11.0.0` → `^16.0.1`.** The previously
  pinned v11 cannot parse current Stellar testnet's transaction metadata at
  all (`TypeError: Bad union switch: 4` from `getTransaction`, reproduced
  below) — testnet is on protocol 27, and per the SDK's changelog, protocol
  27 XDR support was only added in v16.0.0. This is a hard requirement for
  the feature to function against live infrastructure, not a routine bump.
  v13 also fully renamed the `SorobanRpc` namespace to `rpc`, which
  `soroban.ts` uses throughout.
- **`babel.config.js` + `jest.config.js` `transformIgnorePatterns: []`.**
  v16's `@noble/*` transitive dependencies (hashes, ed25519, curves) ship
  ESM only, with no CommonJS build at any version compatible with the API
  surface `@stellar/stellar-sdk` needs — there is no version pin that
  avoids this, so Jest needs to transform them like first-party source
  instead of skipping all of `node_modules` as it does by default.
  Production code is unaffected: it runs via `tsc`/`tsx`, which already
  handle this natively.

## Real testnet run (not mocked)

Deployed `globe-wallet` to testnet for end-to-end verification:

- Contract ID: `CBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K`
- Demo user: `GBLIQBXTAF3O3YINCRDR5O7H47QHHW5GFOYN4HAD6IKOSWD4LWKWWPHP`
  (whitelisted for `XLM`, 10,000,000-stroop daily limit)

This is the same contract ID committed to `.env.example`, so it's live for
review right now.

```
$ curl -s "http://localhost:4000/api/v1/contract/wallet/GBLIQ.../assets"
{"assets":[{"code":"XLM","issuer":null}]}

$ curl -s -X POST http://localhost:4000/api/v1/contract/wallet/spend \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"userSecretKey":"S...","assetCode":"XLM","amount":"1000000"}'
{"hash":"cb23ad46b20bf60ad166b0f4aa317e710792905a5f472b950ba767218cd1608b","ledger":3711371,"successful":true}
# → https://stellar.expert/explorer/testnet/tx/cb23ad46b20bf60ad166b0f4aa317e710792905a5f472b950ba767218cd1608b

# Same call again, this time exceeding the remaining limit (9,000,000 left, asked for 9,500,000):
$ curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:4000/api/v1/contract/wallet/spend \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"userSecretKey":"S...","assetCode":"XLM","amount":"9500000"}'
{"error":"SpendLimitExceeded (contract error #1007): HostError: Error(Contract, #1007)\n\n...","code":"SOROBAN_SIMULATION_FAILED","retryable":false}
HTTP_STATUS:422
# no hash, no fee paid — rejected by simulation in ~1.2s vs. ~7s for the successful call above
```

`get_spend_limit` via the CLI before and after the rejected call both
return `10000000` (the limit is unchanged) — the rejected attempt never
touched contract state, confirming nothing was submitted.
