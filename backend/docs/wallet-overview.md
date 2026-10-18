# Wallet Overview Endpoint

**GitHub Issue:** [#49](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/49)

## Summary

`GET /api/v1/wallet/:publicKey/overview` aggregates balances, tracked assets, spend limits, and USD values into a single response. The home screen calls this endpoint once instead of fanning out to multiple separate endpoints.

## Motivation

The home screen design displays total portfolio value, per-asset balances with fiat equivalents, and spend limits. Fetching that data across six separate requests on a mobile device on a slow network is a poor user experience. This endpoint runs all sub-calls in parallel and returns a unified shape.

## Endpoint

```
GET /api/v1/wallet/:publicKey/overview
```

### Path Parameters

| Parameter   | Type   | Description                         |
|-------------|--------|-------------------------------------|
| `publicKey` | string | Stellar public key (G… address), checksum-validated |

### Authentication

Requires a valid JWT in the `Authorization: Bearer <token>` header.

### Response Shape

```jsonc
{
  "account": {
    "publicKey": "G…",
    "funded": true,
    "sequenceNumber": "…"
  },
  "totalValue": {
    "amount": "1234.56",
    "currency": "USD"
  },
  "assets": [
    {
      "asset": { "code": "XLM", "issuer": null },
      "balance": "500.0000000",
      "spendable": "490.0000000",
      "limit": "1000.00",
      "spentToday": "10.00",
      "price": "0.12",
      "value": "60.00"
    }
  ],
  "warnings": []
}
```

#### `warnings` entries

When a sub-call fails the overall request still returns `200`. The failure is recorded as a warning object instead of aborting:

```jsonc
{
  "section": "spendLimits",
  "code": "CONTRACT_NOT_CONFIGURED",
  "message": "Spend limits contract is not configured for this account."
}
```

### Edge Cases

| Scenario | Behaviour |
|---|---|
| Contract not configured | `limits` omitted per asset; warning added with code `CONTRACT_NOT_CONFIGURED` |
| Unfunded account | `200` response with `funded: false`, empty `assets` array |
| Price fetch timeout | `price` and `value` fields set to `null`; warning added |
| Individual upstream failure | Partial result returned; affected section included in `warnings` |

## Implementation Notes

- Sub-calls (`getAccount`, `getBalances`, `contract.getAssets`, `getSpendLimit`, batch prices) run concurrently with `Promise.allSettled`.
- Each sub-call has an individual timeout so one slow upstream cannot stall the whole response.
- Amounts are represented as strings to preserve precision.
- Addresses are checksum-validated at the route edge before any downstream call.
- Use the shared error envelope; never leak stack traces.

## Performance Target

p95 response time ≤ 800 ms against testnet under normal conditions.

## OpenAPI

The route must be documented in `backend/docs/openapi.yaml` in the same PR. See the existing price and balance entries as a style reference.

## Acceptance Criteria

- [ ] `GET /api/v1/wallet/:publicKey/overview` is implemented and reachable
- [ ] Sub-calls run in parallel with individual timeouts
- [ ] Partial results returned when any upstream fails; failure recorded in `warnings`
- [ ] `CONTRACT_NOT_CONFIGURED` handled gracefully
- [ ] Unfunded account returns `200` with `funded: false`
- [ ] Response documented in OpenAPI spec
- [ ] CI is green (lint, type-check, tests)
- [ ] No new TODOs without a linked issue

## Related Resources

- [Soroban smart contracts docs](https://developers.stellar.org/docs/smart-contracts)
- [OpenAPI 3.1 specification](https://spec.openapis.org/oas/v3.1.0)
- [SQLite WAL mode](https://www.sqlite.org/wal.html)
