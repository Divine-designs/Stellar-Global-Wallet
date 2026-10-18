import * as StellarSdk from "@stellar/stellar-sdk";
import { AppError, NotFoundError } from "../errors/appError";
import { isGAddress } from "../utils/stellarAddress";

/**
 * #63 — resolve anything a user might paste into a "send to" field into the
 * G... account ID (plus memo) a payment actually needs:
 *
 *   - `G...`            returned as-is
 *   - `M...` (muxed)    decoded to its base G... account + 64-bit muxed ID
 *   - `name*domain.com` resolved via the domain's SEP-2 federation server
 *
 * Federation lookups are bounded by FEDERATION_TIMEOUT_MS (3s) so a slow or
 * dead federation server can't hang the request.
 */
export const FEDERATION_TIMEOUT_MS = 3000;

export type ResolvedAddressType = "account" | "muxed" | "federation";

export interface ResolvedAddress {
  type: ResolvedAddressType;
  /** Base G... account ID to pay. */
  accountId: string;
  /** Memo the federation server says to attach (federation only). */
  memo?: string;
  memoType?: "text" | "id" | "hash";
  /** Muxed sub-account ID as a decimal string (muxed only). */
  muxedId?: string;
  /** The muxed M... address to use as the payment destination (muxed only). */
  muxedAddress?: string;
}

/** Minimal shape of a SEP-2 federation response we rely on. */
export interface FederationRecord {
  account_id: string;
  memo_type?: string;
  memo?: string;
}

export type FederationResolver = (
  address: string,
  options: { timeout: number }
) => Promise<FederationRecord>;

const defaultResolver: FederationResolver = (address, options) =>
  StellarSdk.Federation.Server.resolve(address, options) as Promise<FederationRecord>;

// name*domain — name may itself contain "@" (e.g. an email) but not "*".
const FEDERATION_ADDRESS = /^[^*\s]+\*[a-z0-9.-]+\.[a-z]{2,}$/i;

export class FederationTimeoutError extends AppError {
  constructor(address: string) {
    super(`Federation server for ${address} did not respond within ${FEDERATION_TIMEOUT_MS}ms`, {
      code: "FEDERATION_TIMEOUT",
      retryable: true,
      status: 504,
    });
  }
}

export class FederationUnavailableError extends AppError {
  constructor(address: string) {
    super(`Could not resolve ${address}: the domain has no reachable federation server`, {
      code: "FEDERATION_UNAVAILABLE",
      retryable: true,
      status: 502,
    });
  }
}

export class InvalidAddressError extends AppError {
  constructor(message: string) {
    super(message, { code: "INVALID_ADDRESS", status: 400 });
  }
}

export function isFederationAddress(value: string): boolean {
  return FEDERATION_ADDRESS.test(value);
}

export function isMuxedAddress(value: string): boolean {
  return StellarSdk.StrKey.isValidMed25519PublicKey(value);
}

/** True for anything `resolveAddress` accepts — used for edge validation. */
export function isResolvableAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (isGAddress(value) || isMuxedAddress(value) || isFederationAddress(value))
  );
}

export class FederationService {
  constructor(private readonly resolver: FederationResolver = defaultResolver) {}

  async resolveAddress(q: string): Promise<ResolvedAddress> {
    if (isGAddress(q)) {
      return { type: "account", accountId: q };
    }

    if (isMuxedAddress(q)) {
      const muxed = StellarSdk.MuxedAccount.fromAddress(q, "0");
      return {
        type: "muxed",
        accountId: muxed.baseAccount().accountId(),
        muxedId: muxed.id(),
        muxedAddress: q,
      };
    }

    if (isFederationAddress(q)) {
      return this.resolveFederation(q);
    }

    throw new InvalidAddressError(
      "q must be a Stellar account (G...), a muxed account (M...) or a federation address (name*domain.com)"
    );
  }

  private async resolveFederation(address: string): Promise<ResolvedAddress> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FederationTimeoutError(address)), FEDERATION_TIMEOUT_MS);
    });

    let record: FederationRecord;
    try {
      record = await Promise.race([
        this.resolver(address, { timeout: FEDERATION_TIMEOUT_MS }),
        timeout,
      ]);
    } catch (err) {
      throw classifyFederationError(err, address);
    } finally {
      clearTimeout(timer);
    }

    // Never pass through an unchecked account ID from a third-party server.
    if (!record || !isGAddress(record.account_id)) {
      throw new FederationUnavailableError(address);
    }

    const result: ResolvedAddress = { type: "federation", accountId: record.account_id };
    if (record.memo !== undefined && record.memo !== "") {
      const memoType = record.memo_type?.toLowerCase();
      result.memo = String(record.memo);
      result.memoType = memoType === "id" || memoType === "hash" ? memoType : "text";
    }
    return result;
  }
}

function classifyFederationError(err: unknown, address: string): AppError {
  if (err instanceof AppError) return err;

  const e = err as { code?: string; message?: string; response?: { status?: number } };
  if (e?.response?.status === 404) {
    return new NotFoundError(`Federation address ${address} was not found`, "FEDERATION_NOT_FOUND");
  }
  if (e?.code === "ECONNABORTED" || /timeout/i.test(e?.message ?? "")) {
    return new FederationTimeoutError(address);
  }
  return new FederationUnavailableError(address);
}
