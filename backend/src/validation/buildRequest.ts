import * as StellarSdk from "@stellar/stellar-sdk";
import { isValidAccountId } from "./historyQuery";
import { isValidIssuedAsset } from "./stellarAsset";

/**
 * Validators shared by the unsigned-XDR build endpoints. Addresses are
 * checksum-validated (unlike `isGAddress`, which only checks prefix and
 * length), so a mistyped address is a 400 at the edge instead of an SDK
 * exception while building.
 */

/** A payment destination: a G... account or a muxed M... address. */
export function isValidDestination(value: unknown): boolean {
  return (
    isValidAccountId(value) ||
    (typeof value === "string" && StellarSdk.StrKey.isValidMed25519PublicKey(value))
  );
}

export const destinationOrMuxedMessage =
  "Invalid destination: must be a G... account or a muxed M... address.";

/** `XLM`, `native` or `CODE:ISSUER` — the same spellings `/send` accepts. */
export function isValidAssetParam(value: unknown): boolean {
  return value === "XLM" || value === "native" || isValidIssuedAsset(value);
}

export const assetParamMessage = 'asset must be "XLM", "native" or CODE:ISSUER';
