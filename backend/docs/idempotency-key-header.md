# Idempotency-Key Header Support (issue #42)

**GitHub Issue:** [#42](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/42)

## Summary

Mutating endpoints (e.g. `POST /api/v1/wallet/send`) currently read the
idempotency key from the request **body** only (`idempotencyKey`). This
change adds support for supplying it as the standard `Idempotency-Key`
**header** instead, keeping the body field for backwards compatibility.

The header form follows the
[IETF Idempotency-Key draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency/)
and allows SDKs and HTTP clients to inject the key automatically on every
POST without touching the body.

---

## Why this matters

- **Carrier NAT / mobile networks** - SDKs can be configured once to add
  `Idempotency-Key` to every mutating request; callers do not need to
  remember to include it in each body.
- **Spec compliance** - the IETF draft standardises the header name;
  following it makes the API interoperable with generic retry middleware.
- **Backwards compatibility** - existing callers that pass `idempotencyKey`
  in the body continue to work unchanged.

---

## Request Contract

### Sending the key as a header (preferred)

```http
POST /api/v1/wallet/send HTTP/1.1
Authorization: Bearer <jwt>
Idempotency-Key: 01HQK8V5XZYA3B7PNMT6GWD2J1
Content-Type: application/json

{
  "destination": "G...",
  "asset": "native",
  "amount": "10.00"
}
```

### Sending the key in the body (legacy, still supported)

```http
POST /api/v1/wallet/send HTTP/1.1
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "destination": "G...",
  "asset": "native",
  "amount": "10.00",
  "idempotencyKey": "01HQK8V5XZYA3B7PNMT6GWD2J1"
}
```

### Conflict - header and body both present but different

If `Idempotency-Key` header **and** `idempotencyKey` body field are both
supplied and their values differ, the server returns:

```http
HTTP/1.1 400 Bad Request

{
  "code": "IDEMPOTENCY_KEY_CONFLICT",
  "error": "Idempotency-Key header and body field must match when both are present"
}
```

Supplying the same value in both places is allowed and treated as if only
the header was sent.

---

## CORS

`Idempotency-Key` is listed in `Access-Control-Allow-Headers` so browser
clients can include it in cross-origin requests. No additional client-side
configuration is needed.

---

## OpenAPI

The header is documented on every mutating route as an optional header
parameter. Excerpt from `docs/openapi.yaml`:

```yaml
parameters:
  - in: header
    name: Idempotency-Key
    required: false
    schema:
      type: string
      maxLength: 255
    description: >
      Client-generated unique key that prevents duplicate operations on
      retry. Follows the IETF Idempotency-Key draft. If omitted the
      request is not idempotency-protected.
```

---

## Implementation notes

The lookup order in `handleIdempotentRequest` (inside
`src/services/idempotency.ts`) is:

1. `req.get('Idempotency-Key')` - header value
2. `req.body.idempotencyKey` - body value
3. If both are present and differ -> `400 IDEMPOTENCY_KEY_CONFLICT`
4. If neither is present -> request proceeds without idempotency protection
   (same behaviour as before this change)

The resolved key is passed into `getCachedResult` / `storeResult` unchanged,
so the storage layer (`idempotency_keys` table) requires no schema changes.

---

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `IDEMPOTENCY_KEY_CONFLICT` | `400` | Header and body key present but different |

All other idempotency error codes (`IDEMPOTENCY_REPLAY_MISMATCH`, etc.)
are unchanged - see [`docs/error-examples.md`](./error-examples.md).

---

## Related issues

- [#2 - Add POST /api/v1/wallet/submit for submitting client-signed transaction XDR](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/2)

## Resources

- [IETF Idempotency-Key header draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency/)
- [OpenAPI 3.1 specification](https://spec.openapis.org/oas/v3.1.0)
