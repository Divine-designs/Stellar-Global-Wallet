/**
 * Curated verified-asset allowlist (#54).
 *
 * Threat: anyone can issue an asset called "USDC" from their own account
 * and airdrop it to users, hoping they mistake it for Circle's USDC (and
 * e.g. "sell" it, or accept it as payment). Asset codes are not unique on
 * Stellar — only `code:issuer` is — so the UI needs a reviewed list of
 * the issuers that are the real thing to highlight them and warn on
 * lookalikes.
 *
 * The lists live in `backend/data/verified-assets.<network>.json` and are
 * covered by a CODEOWNERS rule, so every change goes through a PR that a
 * maintainer must approve. They are validated strictly at load time
 * (deny-by-default: an unknown field, a malformed code, or an issuer that
 * fails the StrKey checksum makes the process refuse to start rather than
 * silently serving a partially-trusted list).
 */

import fs from "fs";
import path from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { z } from "zod";
import { config } from "../config";

export type StellarNetwork = "testnet" | "mainnet";

const verifiedAssetSchema = z
  .object({
    code: z.string().regex(/^[a-zA-Z0-9]{1,12}$/, "must be a 1-12 character alphanumeric asset code"),
    issuer: z
      .string()
      .refine((v) => StellarSdk.StrKey.isValidEd25519PublicKey(v), "must be a valid Stellar public key (G...)"),
    domain: z
      .string()
      .regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, "must be a lowercase home domain, e.g. centre.io"),
    name: z.string().min(1).max(64),
    // CoinGecko coin id used by the price oracle (#55). Only assets on this
    // list are ever priced via CoinGecko — mapping by bare code would price
    // a scam "USDC" at $1.
    coingeckoId: z.string().regex(/^[a-z0-9-]+$/).optional(),
    // True for the USD stablecoin used as the DEX quote asset (#55).
    usdPeg: z.boolean().optional(),
  })
  .strict();

export const verifiedAssetListSchema = z
  .object({
    network: z.enum(["testnet", "mainnet"]),
    assets: z.array(verifiedAssetSchema),
  })
  .strict()
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.assets.forEach((asset, i) => {
      const key = `${asset.code}:${asset.issuer}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", i], message: `duplicate asset ${key}` });
      }
      seen.add(key);
    });
  });

export type VerifiedAsset = z.infer<typeof verifiedAssetSchema>;
export type VerifiedAssetList = z.infer<typeof verifiedAssetListSchema>;

export const VERIFIED_ASSETS_DIR = path.resolve(__dirname, "../../data");

export function verifiedAssetsFile(network: StellarNetwork): string {
  return path.join(VERIFIED_ASSETS_DIR, `verified-assets.${network}.json`);
}

/** Reads and strictly validates one network's list. Throws on any problem. */
export function loadVerifiedAssetList(network: StellarNetwork, file = verifiedAssetsFile(network)): VerifiedAssetList {
  const parsed = verifiedAssetListSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (parsed.network !== network) {
    throw new Error(`${file} declares network "${parsed.network}" but was loaded for "${network}"`);
  }
  return parsed;
}

const cache = new Map<StellarNetwork, VerifiedAssetList>();

/** The list for the configured network, loaded once per process. */
export function getVerifiedAssets(network: StellarNetwork = config.STELLAR_NETWORK): readonly VerifiedAsset[] {
  let list = cache.get(network);
  if (!list) {
    list = loadVerifiedAssetList(network);
    cache.set(network, list);
  }
  return list.assets;
}

/** `CODE:ISSUER` keys, in the same shape paymentFlags.ts uses. */
export function verifiedAssetKeys(network: StellarNetwork = config.STELLAR_NETWORK): ReadonlySet<string> {
  return new Set(getVerifiedAssets(network).map((a) => `${a.code}:${a.issuer}`));
}

export function findVerifiedAsset(
  code: string,
  issuer: string,
  network: StellarNetwork = config.STELLAR_NETWORK
): VerifiedAsset | undefined {
  return getVerifiedAssets(network).find((a) => a.code === code && a.issuer === issuer);
}
