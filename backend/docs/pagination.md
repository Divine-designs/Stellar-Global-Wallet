# Pagination

All list endpoints share one cursor-based pagination contract.

## Query parameters

| Param    | Type    | Required | Description                                                        |
| -------- | ------- | -------- | ------------------------------------------------------------------ |
| `cursor` | string  | no       | Opaque paging token returned as `nextCursor` by a previous page.   |
| `limit`  | integer | no       | Page size. Must be between `1` and `100` (inclusive).              |

Cursors are opaque tokens (for example, Horizon paging tokens). Clients
**must not** parse or construct them — pass the value from `nextCursor`
back verbatim.

## Response shape

```json
{
  "items": [ /* ... */ ],
  "nextCursor": "1234567890"
}
```

- `items` — the page of results.
- `nextCursor` — the token to fetch the next page, or `null` when there are
  no more results.

## Errors

Invalid input is rejected with the shared error envelope and a stable code:

| Code              | Status | Cause                                  |
| ----------------- | ------ | -------------------------------------- |
| `INVALID_CURSOR`  | 400    | `cursor` is not a string.              |
| `INVALID_LIMIT`   | 400    | `limit` is not a positive integer.     |
| `LIMIT_TOO_LARGE` | 400    | `limit` is greater than `100`.         |

## Deprecations

`GET /account/:publicKey/transactions` previously returned `next` and
`hasMore`. These fields are **deprecated** and will be removed in a future
version. Use `items` and `nextCursor` instead.

## Helper

The shared implementation lives in `backend/src/pagination.ts`:

- `PageQuery { cursor?: string; limit?: number }`
- `Page<T> { items: T[]; nextCursor: string | null }`
- `parsePageQuery(raw)` — validates and normalises query input.
- `paginate(items, nextCursor)` — builds a `Page<T>`.
