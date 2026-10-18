# SSE Stream for Transaction Status Updates (issue #44)

**GitHub Issue:** [#44](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/44)

## Summary

After `POST /api/v1/wallet/submit` a transaction can remain pending for
several seconds before inclusion or timeout. Polling wastes requests and
adds latency. `GET /api/v1/stream/tx/:hash` is a short-lived SSE stream
that pushes `pending -> success | failed` transitions to the caller, then
closes once a terminal state is reached or 60 seconds elapse.

For the shared event envelope and payload shapes see
[`docs/realtime-event-schema.md`](./realtime-event-schema.md).

---

## Endpoint

```
GET /api/v1/stream/tx/:hash
```

| Parameter | Location | Description |
|-----------|----------|-------------|
| `hash` | path | Transaction hash (64-character hex string) |

**Authentication:** `Authorization: Bearer <jwt>`

**Response headers set by the server:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` instructs NGINX and Render's proxy layer to
disable response buffering so events are delivered immediately.

---

## Event shape

All events use the `EventEnvelope<TxStatusEvent>` shape from
`packages/types/src/events.ts`:

```ts
interface TxStatusEvent {
  type: "tx.status";
  data: {
    txHash: string;
    status: "pending" | "success" | "failed";
    ledger?: number;      // present when status === "success"
    errorCode?: string;   // present when status === "failed"
  };
}
```

### Wire format

```
id: 01HQK9V5XZYA3B7PNMT6GWD2J1
event: tx.status
data: {"type":"tx.status","id":"01HQK9...","occurredAt":"2026-10-18T14:22:01Z","version":1,"data":{"txHash":"abc123...","status":"pending"}}

id: 01HQK9V5XZYA3B7PNMT6GWD2J2
event: tx.status
data: {"type":"tx.status","id":"01HQK9...","occurredAt":"2026-10-18T14:22:03Z","version":1,"data":{"txHash":"abc123...","status":"success","ledger":52340187}}

```

The stream closes immediately after the `success` or `failed` event.

---

## Heartbeat

A comment line is sent every 15 seconds to keep connections alive through
proxies that close idle connections:

```
: heartbeat
```

Clients should ignore lines beginning with `:`.

---

## Timeout and terminal states

| Condition | Action |
|-----------|--------|
| `success` or `failed` received from Horizon / RPC | Emit final event, close stream |
| 60 seconds elapsed without terminal status | Emit `{"status":"failed","errorCode":"TX_TIMEOUT"}`, close stream |
| Client disconnects (`req.on('close')`) | Stop polling immediately, release server resources |

Polling interval is 1 second. Each poll calls `GET /transactions/:hash` on
Horizon (classic) or `getTransaction` on Soroban RPC depending on the
transaction type.

---

## Proxy buffering

| Reverse proxy | Required config |
|---------------|----------------|
| NGINX | `proxy_buffering off;` on the location block, or rely on `X-Accel-Buffering: no` |
| Render | No extra config; `X-Accel-Buffering: no` is honoured |
| AWS ALB / CloudFront | Ensure idle-timeout > 60 s |

---

## Error responses

Errors before the stream opens are returned as normal JSON:

| Scenario | HTTP | Code |
|----------|------|------|
| Missing / invalid JWT | `401` | `UNAUTHORIZED` |
| `hash` format invalid | `400` | `VALIDATION_ERROR` |
| Hash not found at stream open | `404` | `TX_NOT_FOUND` |

Once the SSE stream is open, errors are delivered as a final `tx.status`
event with `status: "failed"` and an `errorCode`. No raw JSON is emitted
after headers are sent.

---

## Usage example (browser via SDK)

```ts
import { subscribe } from "@stellar-global-wallet/sdk";

const controller = new AbortController();

subscribe("stream/tx/" + txHash, (event) => {
  if (event.type === "tx.status") {
    console.log(event.data.status);
    if (event.data.status !== "pending") controller.abort();
  }
}, { signal: controller.signal });
```

See [`docs/sdk-sse-subscribe.md`](./sdk-sse-subscribe.md) for the full SDK
API and reconnect behaviour.

---

## Related issues

- [#45 - Stream account balance and payment events](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/45)
- [#47 - Define a realtime event schema shared between backend and SDK](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/47)
- [#48 - SDK SSE subscribe helper](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/48)

## Resources

- [MDN Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Horizon API reference](https://developers.stellar.org/docs/data/horizon)
- [Soroban RPC getTransaction](https://developers.stellar.org/docs/data/rpc/api-reference/methods/getTransaction)
