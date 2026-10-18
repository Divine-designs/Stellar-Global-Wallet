# Per-Account Rate Limits for Authenticated Endpoints (issue #43)

**GitHub Issue:** [#43](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/43)

## Summary

The existing global limiter keys on client IP (100 req / 15 min). Mobile
users behind carrier NAT (CGNAT) share a single public IP, so unrelated
accounts drain each other's budget. A single malicious account can also
rotate IPs to evade the IP-based limit entirely.

This change adds a **second rate limiter**, applied after `jwtAuth`,
that keys on `req.user.sub` with differentiated budgets per operation class.

For the existing IP-based limiter and client backoff guidance see
[`docs/rate-limits.md`](./rate-limits.md).

---

## Threat model

| Attacker | What they can do today | What this closes |
|----------|------------------------|-----------------|
| Single account behind many IPs | Evade the global IP limiter by rotating exit nodes | Per-account limit applies regardless of source IP |
| Legitimate users on CGNAT | Exhaust the shared IP bucket for all co-located users | Each account gets its own independent quota |

---

## Budgets

| Operation class | Example routes | Limit | Window |
|-----------------|---------------|-------|--------|
| **Reads** | `GET /balances`, `GET /history`, `GET /assets` | 300 req | 15 min |
| **Builds** | `POST /wallet/send/build`, `POST /wallet/soroban/record_spend/build` | 60 req | 15 min |
| **Submits** | `POST /wallet/submit`, `POST /wallet/send` | 20 req | 15 min |

Values are tunable via environment variables - see
[`docs/environments.md`](./environments.md).

---

## Headers

All three limiters emit IETF `RateLimit-*` draft headers
(`standardHeaders: true`, `legacyHeaders: false`):

| Header | Meaning |
|--------|---------|
| `RateLimit-Limit` | Quota for this window |
| `RateLimit-Remaining` | Requests left |
| `RateLimit-Reset` | Seconds until window resets |
| `Retry-After` | Seconds to wait (only on `429`) |

The `429` body follows the standard error envelope:

```json
{
  "code": "ACCOUNT_RATE_LIMITED",
  "error": "Too many requests for this account, please slow down"
}
```

---

## Store configuration

### Single-instance (default)

Uses the in-process memory store. Suitable for development and single-process
deployments.

### Multi-instance (`LOCK_BACKEND=redis`)

When `LOCK_BACKEND=redis`, the per-account limiter switches to the
`rate-limit-redis` store so all backend instances share a single counter per
account. The Redis connection reuses the same client already configured for
distributed locks (see [`docs/concurrency.md`](./concurrency.md)).

```
LOCK_BACKEND=redis
REDIS_URL=redis://localhost:6379
```

---

## Middleware order

```
Request
  -> global IP limiter          (all routes, 100 / 15 min)
       -> jwtAuth               (authenticated routes only)
            -> per-account limiter  (keyed on req.user.sub)
                 -> route handler
```

Unauthenticated routes (e.g. `POST /auth/login`, `GET /health`) are **not**
affected. The login route retains its own dedicated IP limiter (10 / 15 min).

---

## OpenAPI

Per-account limits are documented on affected routes using the IETF
`RateLimit-*` response header schema. The `429` response is listed for every
route covered by the per-account limiter.

---

## Implementation notes

Key outline in `src/app.ts` / `src/middleware/`:

```ts
const perAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => LIMITS_BY_CLASS[routeClass(req)] ?? LIMITS_BY_CLASS.read,
  keyGenerator: (req) => (req as AuthenticatedRequest).user.sub,
  store: process.env.LOCK_BACKEND === "redis" ? redisStore : undefined,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({ code: "ACCOUNT_RATE_LIMITED", error: "..." }),
});
```

`routeClass` maps request paths to `"read" | "build" | "submit"` without
coupling the limiter to individual route files.

---

## Migration path for existing clients

- Clients under the new per-account limits see no change.
- Clients relying on IP rotation to exceed limits will be capped per account.
- `RateLimit-*` headers are already present on all responses; no SDK changes
  are needed to handle the new headers.

---

## Related issues

- [#1 - Add POST /api/v1/wallet/send/build](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/1)
- [#4 - Return unsigned XDR for Soroban record_spend](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/4)
- [#11 - Deprecate secret-key accepting endpoints](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/11)

## Resources

- [IETF RateLimit header fields draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
- [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit)
- [rate-limit-redis](https://github.com/express-rate-limit/rate-limit-redis)
