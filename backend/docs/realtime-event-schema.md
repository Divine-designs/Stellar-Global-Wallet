# Realtime Event Schema

**GitHub Issue:** [#47](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/47)

## Summary

This document defines the canonical event names and payload shapes shared between the backend and the SDK. Agreeing on the schema up-front lets both sides evolve together without silent mismatches.

## Motivation

The backend emits events over SSE; the SDK consumes them. If both sides define their own ad-hoc event shapes, the first time they diverge causes a silent runtime failure. A single source of truth in `packages/types` enforces consistency at compile time across backend, web, and mobile.

## TypeScript Definition

The canonical schema lives at `packages/types/src/events.ts`.

```ts
/** Semantic version of the event envelope. Increment on breaking changes. */
export const EVENT_SCHEMA_VERSION = 1;

export interface EventEnvelope<T extends RealtimeEvent> {
  /** Discriminant — matches RealtimeEvent["type"] */
  type: T["type"];
  /** Stable UUID for idempotency / deduplication */
  id: string;
  /** ISO-8601 UTC timestamp */
  occurredAt: string;
  /** Schema version — allows clients to ignore events they don't understand */
  version: number;
  data: T["data"];
}

// ── Individual event types ────────────────────────────────────────────────────

export interface TxStatusEvent {
  type: "tx.status";
  data: {
    txHash: string;
    status: "pending" | "success" | "failed";
    ledger?: number;
    errorCode?: string;
  };
}

export interface PaymentReceivedEvent {
  type: "payment.received";
  data: {
    txHash: string;
    from: string;
    asset: { code: string; issuer: string | null };
    amount: string;
  };
}

export interface RecoveryInitiatedEvent {
  type: "recovery.initiated";
  data: {
    contractId: string;
    proposer: string;
    newOwner: string;
    expiresAt: string;
  };
}

export interface RecoveryApprovedEvent {
  type: "recovery.approved";
  data: {
    contractId: string;
    guardian: string;
    approvalsCollected: number;
    approvalsRequired: number;
  };
}

export interface RecoveryRevokedEvent {
  type: "recovery.revoked";
  data: {
    contractId: string;
    revokedBy: string;
  };
}

export interface RecoveryExecutedEvent {
  type: "recovery.executed";
  data: {
    contractId: string;
    newOwner: string;
    executedAt: string;
  };
}

export interface RecoveryCancelledEvent {
  type: "recovery.cancelled";
  data: {
    contractId: string;
    cancelledBy: string;
  };
}

// ── Discriminated union ───────────────────────────────────────────────────────

export type RealtimeEvent =
  | TxStatusEvent
  | PaymentReceivedEvent
  | RecoveryInitiatedEvent
  | RecoveryApprovedEvent
  | RecoveryRevokedEvent
  | RecoveryExecutedEvent
  | RecoveryCancelledEvent;

export type RealtimeEventType = RealtimeEvent["type"];
```

## Event Reference

| Event type              | Emitter      | Audience            | Trigger                                      |
|-------------------------|--------------|---------------------|----------------------------------------------|
| `tx.status`             | Backend      | Owner               | Transaction ledger status change             |
| `payment.received`      | Backend      | Owner               | Incoming payment detected by indexer         |
| `recovery.initiated`    | Backend      | Owner + guardians   | Recovery proposal created on-chain           |
| `recovery.approved`     | Backend      | Owner + guardians   | Guardian signs approval                      |
| `recovery.revoked`      | Backend      | Owner + guardians   | Guardian revokes prior approval              |
| `recovery.executed`     | Backend      | Owner + guardians   | Recovery threshold reached, ownership transferred |
| `recovery.cancelled`    | Backend      | Owner + guardians   | Recovery cancelled before execution          |

## Versioning

- `version` is a monotonically increasing integer in the envelope.
- Clients **must** ignore events with a `version` higher than they understand rather than erroring.
- Breaking changes (field removal, type change) require a version bump and a changelog entry.
- Additive changes (new optional field) do not require a version bump.

## JSON Schema

A JSON Schema file is generated from the TypeScript types and published alongside the package for use by non-TypeScript clients. The generation script is `packages/types/scripts/generate-json-schema.ts`.

## Acceptance Criteria

- [ ] `packages/types/src/events.ts` exports `RealtimeEvent` discriminated union
- [ ] `EVENT_SCHEMA_VERSION` constant exported and used by backend emitter
- [ ] JSON Schema generated and checked in to `packages/types/schema/`
- [ ] SDK re-exports all event types from its public entry point
- [ ] CI is green (lint, type-check, tests)
- [ ] No new TODOs without a linked issue

## Related Issues

- [#48 — Add an SDK helper for subscribing to SSE streams with reconnect](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/48)
- [#46 — Emit realtime events for recovery proposals and guardian approvals](https://github.com/Genghis-codes/Stellar-Global-Wallet/issues/46)

## Related Resources

- [Soroban RPC getEvents](https://developers.stellar.org/docs/data/rpc/api-reference/methods/getEvents)
- [Expo push notifications](https://docs.expo.dev/push-notifications/overview/)
