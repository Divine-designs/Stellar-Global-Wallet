/**
 * Curated list of verified issued assets (issues #53, #54).
 *
 * "Verified" means this deployment vouches that CODE:ISSUER is the asset
 * users almost certainly mean when they type CODE — e.g. Circle's USDC
 * rather than one of the many lookalike `USDC` issuers on the network.
 * It is not a statement about the asset's value or safety.
 *
 * The built-in list is deliberately tiny and per-network. Operators extend
 * it per environment with `VERIFIED_ASSETS` (comma-separated CODE:ISSUER),
 * the same variable the activity feed's `unknown_asset` flag reads, so both
 * features always agree on what "verified" means.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config";
import { assetKey, parseVerifiedAssetsList } from "./paymentFlags";

export interface CuratedAsset {
  code: string;
  issuer: string;
}

const CURATED_BY_PASSPHRASE: Record<string, CuratedAsset[]> = {
  [StellarSdk.Networks.PUBLIC]: [
    {
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    },
  ],
  [StellarSdk.Networks.TESTNET]: [
    {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
  ],
};

export class VerifiedAssetRegistry {
  private readonly keys: ReadonlySet<string>;

  constructor(curated: CuratedAsset[], extraKeys: ReadonlySet<string>) {
    this.keys = new Set([...curated.map((a) => assetKey(a.code, a.issuer)), ...extraKeys]);
  }

  isVerified(code: string, issuer: string): boolean {
    return this.keys.has(assetKey(code, issuer));
  }

  /** Every verified CODE:ISSUER pair for `code` (case-sensitive, as on-chain). */
  issuersForCode(code: string): string[] {
    const prefix = `${code}:`;
    return [...this.keys].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
}

export function createVerifiedAssetRegistry(): VerifiedAssetRegistry {
  return new VerifiedAssetRegistry(
    CURATED_BY_PASSPHRASE[config.NETWORK_PASSPHRASE] ?? [],
    parseVerifiedAssetsList(config.VERIFIED_ASSETS)
  );
}
