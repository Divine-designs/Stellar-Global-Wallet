# SDK SSE Subscribe Helper

**GitHub Issue:** [#48](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/48)

## Summary

A typed `subscribe()` helper in the SDK wraps `EventSource` (and a React Native polyfill) with JWT auth, exponential back-off reconnect, and `Last-Event-ID` resume support. Consumers get a single consistent API regardless of platform.

## Motivation

The native browser `EventSource` API cannot send `Authorization` headers, and it does not exist in React Native at all. Without a wrapper, every caller must reimplement auth injection, reconnect logic, and token refresh handling. Centralising this in the SDK gives web and mobile a single, tested, typed interface.

## Public API

```ts
import { subscribe } from "@stellar-global-wallet/sdk";
import type { RealtimeEvent } from "@stellar-global-wallet/types";

const controller = new AbortController();

subscribe<RealtimeEvent>(
  "recovery",           // channel name — maps to /api/v1/stream/recovery
  (event) => {
    console.log(event.type, event.data);
  },
  {
    signal: controller.signal,   // call controller.abort() to unsubscribe
    onError: (err) => console.error(err),
  }
);

// Later:
controller.abort();
```

### `subscribe` Signature

```ts
function subscribe<T extends RealtimeEvent>(
  channel: string,
  onEvent: (event: EventEnvelope<T>) => void,
  options?: SubscribeOptions
): void;

interface SubscribeOptions {
  /** AbortSignal to stop the subscription cleanly */
  signal?: AbortSignal;
  /** Called on connection errors; returning false stops retries */
  onError?: (error: Error) => boolean | void;
  /** Override base URL (defaults to SDK config) */
  baseUrl?: string;
}
```

## Implementation Details

### Platform Adapter

| Platform    | Underlying transport                               |
|-------------|----------------------------------------------------|
| Web         | `@microsoft/fetch-event-source` (supports headers) |
| React Native| `react-native-sse` polyfill                        |

Both are hidden behind a single internal `createEventSource` factory that is swapped at bundle time. No Node-only modules appear in the runtime path.

### Reconnect Strategy

```
attempt 1 → 1 s delay
attempt 2 → 2 s delay
attempt 3 → 4 s delay
attempt N → min(2^(N-1), 60) s delay   (cap 60 s)
jitter     → ±10 % of computed delay
```

The `Last-Event-ID` header is sent on every reconnect so the server can resume from the last delivered event.

### Token Refresh During Long-Lived Streams

If the JWT expires while a stream is open:

1. The server responds with `401`.
2. The helper calls the SDK's token-refresh callback (configured at SDK init time).
3. If refresh succeeds the connection is re-opened with the new token.
4. If refresh fails the `onError` callback is invoked and retries stop.

### Memory and Rate Bounds

- Incoming messages that arrive faster than the handler can process are dropped after a configurable queue depth (default: 100 messages). A warning is emitted to `console.warn`.
- Each `subscribe` call opens at most one underlying connection. Calling `subscribe` a second time on the same channel reuses the connection and adds a listener.

## Usage Example (React)

```tsx
import { useEffect } from "react";
import { subscribe } from "@stellar-global-wallet/sdk";
import type { RecoveryInitiatedEvent } from "@stellar-global-wallet/types";

function RecoveryBanner({ publicKey }: { publicKey: string }) {
  useEffect(() => {
    const controller = new AbortController();

    subscribe<RecoveryInitiatedEvent>("recovery", (event) => {
      if (event.type === "recovery.initiated") {
        alert(`Recovery started by ${event.data.proposer}`);
      }
    }, { signal: controller.signal });

    return () => controller.abort();
  }, [publicKey]);

  return null;
}
```

## Acceptance Criteria

- [ ] `subscribe(channel, handler, options?)` exported from SDK public entry point
- [ ] Works on web (via `@microsoft/fetch-event-source`) and React Native (via `react-native-sse`)
- [ ] Exponential back-off with `Last-Event-ID` on reconnect
- [ ] Token refresh during a long-lived stream handled
- [ ] Per-connection message queue bounded; drops logged
- [ ] Unit tests written against a fake `EventSource`
- [ ] SDK README updated with usage example
- [ ] CI is green (lint, type-check, tests)
- [ ] No new TODOs without a linked issue

## Related Issues

- [#47 — Define a realtime event schema shared between backend and SDK](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/47)
- [#46 — Emit realtime events for recovery proposals and guardian approvals](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/46)

## Related Resources

- [MDN Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [@microsoft/fetch-event-source](https://github.com/Azure/fetch-event-source)
- [Expo push notifications](https://docs.expo.dev/push-notifications/overview/)
