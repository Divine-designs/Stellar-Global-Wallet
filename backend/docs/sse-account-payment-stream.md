# SSE Stream for Account Balance and Payment Events (issue #45)

**GitHub Issue:** [#45](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/45)

## Summary

`GET /api/v1/stream/account/:publicKey` proxies Horizon's payment stream for
a single account, normalises events to the shared `PaymentReceivedEvent`
shape, and fans them out to all authenticated clients subscribed to that
account. Live incoming-payment notifications are the key "magic moment" of a
wallet dashboard.

For the shared event envelope and payload shapes see
[`docs/realtime-event-schema.md`](./realtime-event-schema.md).
For the transaction-status stream see
[`docs/sse-tx-status-stream.md`](./sse-tx-status-stream.md).

---

## Endpoint

```
GET /api/v1/stream/account/:publicKey
```

| Parameter | Location | Description |
|-----------|----------|-------------|
| `publicKey` | path | Stellar account public key (`G...`, 56 chars) |

**Authentication:** `Authorization: Bearer <jwt>`. The authenticated account
(`req.user.sub`) must match `publicKey`; subscribing to another account's
stream returns `403`.

**Response headers set by the server:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

---

## Event shape

All events use `EventEnvelope<PaymentReceivedEvent>`:

```ts
interface PaymentReceivedEvent {
  type: "payment.received";
  data: {
    txHash: string;
    from: string;
    asset: {
      code: string;
      issuer: string | null;
    };
    amount: string;
  };
}
```

### Wire format

```
id: 01HQK9V5XZYA3B7PNMT6GWD2J3
event: payment.received
data: {"type":"payment.received","id":"01HQK9...","occurredAt":"2026-10-18T14:25:10Z","version":1,"data":{"txHash":"def456...","from":"GABC...","asset":{"code":"USDC","issuer":"GA5ZS..."},"amount":"50.0000000"}}

```

---

## Upstream connection sharing

Horizon's `payments().forAccount(id).cursor('now').stream()` is opened
**once per account**, regardless of how many clients are subscribed.
Events are fanned out in-process to all current subscribers.

```
Horizon upstream (1 per account)
         |
         v
  normalise -> EventEnvelope<PaymentReceivedEvent>
         |
    fan-out loop
   +-----+------+
 client A    client B
```

When the last client for an account disconnects, the upstream Horizon stream
is closed to release the connection.

---

## Resumption with `Last-Event-ID`

The SSE `id` field in every event is the Horizon **paging token** (cursor)
for that payment operation. On reconnect, clients send `Last-Event-ID` and
the server opens a new Horizon stream from that cursor, replaying any
missed events:

```http
GET /api/v1/stream/account/G... HTTP/1.1
Authorization: Bearer <jwt>
Last-Event-ID: 185651655532556289-0
```

Clients without `Last-Event-ID` receive only events arriving after they
connect (`cursor('now')`).

---

## Heartbeat

A comment line is sent every 15 seconds to keep idle connections alive:

```
: heartbeat
```

---

## Upstream disconnect and reconnect

If the Horizon upstream drops:

1. Server waits 1 s then reopens using the last received paging token.
2. Reconnect attempts use exponential backoff: 1s, 2s, 4s... capped at 60 s
   with +/-10% jitter.
3. While reconnecting, clients receive heartbeats only.
4. After 5 consecutive failed attempts the server emits a comment
   `event: upstream.error` and closes all subscriber connections for that
   account.

---

## Backpressure

Each subscriber's outbound queue is bounded at **100 messages**. If a
subscriber cannot consume events fast enough:

1. Events beyond queue depth are dropped for that subscriber.
2. A `console.warn` is emitted server-side.
3. The subscriber is not disconnected; it resumes from the live position.

Clients that need completeness should reconnect with `Last-Event-ID` after
a gap to replay missed events.

---

## Error responses

| Scenario | HTTP | Code |
|----------|------|------|
| Missing / invalid JWT | `401` | `UNAUTHORIZED` |
| `publicKey` format invalid | `400` | `VALIDATION_ERROR` |
| JWT `sub` does not match `publicKey` | `403` | `FORBIDDEN` |
| Account not found on Horizon | `404` | `ACCOUNT_NOT_FOUND` |

---

## Usage example (via SDK)

```ts
import { subscribe } from "@stellar-global-wallet/sdk";
import type { PaymentReceivedEvent } from "@stellar-global-wallet/types";

const controller = new AbortController();

subscribe<PaymentReceivedEvent>(
  "account/" + myPublicKey,
  (event) => {
    if (event.type === "payment.received") {
      console.log("+" + event.data.amount + " " + event.data.asset.code);
      refreshBalances();
    }
  },
  { signal: controller.signal }
);

// On logout / unmount:
controller.abort();
```

See [`docs/sdk-sse-subscribe.md`](./sdk-sse-subscribe.md) for the full
SDK API and reconnect behaviour.

---

## Memory and connection bounds

| Resource | Bound |
|----------|-------|
| Horizon upstream connections | 1 per unique `publicKey` with >= 1 subscriber |
| Subscriber queue depth | 100 messages per subscriber |
| Max concurrent SSE connections | Governed by load-balancer / Node.js maxSockets |

---

## Related issues

- [#44 - SSE stream for transaction status updates](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/44)
- [#47 - Define a realtime event schema shared between backend and SDK](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/47)
- [#48 - SDK SSE subscribe helper](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/48)

## Resources

- [Horizon payments stream](https://developers.stellar.org/docs/data/horizon/api-reference/resources/operations/object/payment)
- [Soroban RPC getEvents](https://developers.stellar.org/docs/data/rpc/api-reference/methods/getEvents)
- [MDN Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
