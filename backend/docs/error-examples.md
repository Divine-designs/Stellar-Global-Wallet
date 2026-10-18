# Error Examples

This document describes the error-case examples that are included in the
OpenAPI spec (`backend/docs/openapi.yaml`) and how to exercise them with the
mock server.

## Running the mock server

```bash
npm run mock
```

This starts [Prism](https://github.com/stoplightio/prism) on
`http://localhost:4010`, serving the OpenAPI spec with the static `examples`
defined for each schema (`--dynamic=false`). Responses are deterministic, so
they are safe to use in tests and offline frontend work.

## Forcing error responses

Prism lets you request a specific response by status code using the
`Prefer` header. To force an error example, pass the status code you want:

```bash
# Force a 429 Too Many Requests response
curl -H 'Prefer: code=429' http://localhost:4010/accounts

# Force a 404 Not Found response
curl -H 'Prefer: code=404' http://localhost:4010/accounts/does-not-exist

# Force a 400 Bad Request response
curl -H 'Prefer: code=400' http://localhost:4010/recovery/initiate
```

If the spec defines an `example` for that status code, Prism returns it
verbatim. Otherwise Prism generates a response from the schema.

## Error examples in the spec

The following error cases have explicit examples in the spec:

| Status | Meaning              | Where it applies                          |
| ------ | -------------------- | ----------------------------------------- |
| 400    | Bad Request          | Request validation failures               |
| 404    | Not Found            | Unknown account / recovery identifiers    |
| 429    | Too Many Requests    | Rate-limited endpoints                    |
| 500    | Internal Server Error| Unexpected server failures                |

Each error response follows the shared `Error` schema:

```json
{
  "error": "rate_limited",
  "message": "Too many requests, please retry later."
}
```

## Using error examples in tests

Unit tests should not hit the network. Instead, import the recorded fixtures
from `packages/sdk/mocks` (or the spec examples) and assert against them.
When you need to verify error handling end-to-end, start the mock server and
use the `Prefer: code=<status>` header as shown above.
