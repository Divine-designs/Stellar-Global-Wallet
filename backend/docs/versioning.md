# API Versioning Policy

This document defines how the Stellar Global Wallet backend introduces
changes to its HTTP API, how long old versions live, and how clients learn
that they are too old. It is the source of truth for anyone changing a
route under `/api/v1`.

## Version scheme

The API is versioned in the URL path: `/api/v1/...`. The major component
(`v1`) only changes when a **breaking** change ships. Every response also
carries an `X-API-Version` header of the form `1.<minor>`, where `<minor>`
is the backend package's minor version. Clients should log this header so
drift is visible in the field.

## What counts as breaking

**Non-breaking (additive) — safe to ship in `v1`:**

- Adding a new endpoint.
- Adding a new optional request field or query parameter.
- Adding a new field to a response object.
- Adding a new error code (existing codes keep their meaning).
- Relaxing validation (accepting more inputs than before).

**Breaking — requires a new major version (`/api/v2`):**

- Removing or renaming a response field.
- Changing the type of a field (e.g. number → string).
- Removing or renaming an endpoint.
- Making a previously optional request field required.
- Tightening validation so previously valid requests are rejected.
- Changing the meaning of an existing error code.
- Changing behaviour behind the same contract in a way clients can observe
  (e.g. a field that used to be a decimal string now returns stroops).

## Deprecation window

When `/api/v2` ships, `/api/v1` stays available for **at least 6 months**.
During that window:

- `v1` keeps receiving security fixes and critical bug fixes.
- New features land only in `v2`.
- Deprecated endpoints may return a `Sunset` header
  ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) with the planned
  removal date.

## Telling clients they are too old

The `/config` endpoint exposes `minClientVersion`. Clients older than this
value should prompt the user to update. Bumping `minClientVersion` is a
breaking change for the affected clients and must follow the deprecation
window above.

## Contract upgrades behind the same API

If a Soroban contract upgrade changes observable behaviour (new fields,
changed units, different error codes), treat it as a breaking API change
even though the URL is unchanged: bump the major version or gate the new
behaviour behind a new field so old clients keep working.
