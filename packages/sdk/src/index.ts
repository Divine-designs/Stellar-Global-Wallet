/**
 * @globe-wallet/sdk — the public, versioned client for the GlobeWallet
 * Soroban contracts.
 *
 * This package re-exports the generated `globe-wallet` contract bindings
 * (see `@globe-wallet/bindings-globe-wallet`, regenerated from the deployed
 * contract spec by `.github/workflows/contract-bindings.yml` — never
 * hand-edit that package) and adds a small convenience layer on top so
 * integrators don't need to know the on-chain contract ID or network
 * passphrase to get started.
 *
 * Works in Node, browsers and React Native: it only depends on
 * `@stellar/stellar-sdk`, which has no Node-only requirements in its
 * contract-client runtime path.
 */
import { Client as GlobeWalletClient } from "@globe-wallet/bindings-globe-wallet";
import type { ClientOptions as GlobeWalletClientOptions } from "@stellar/stellar-sdk/contract";

export type { GlobeWalletClientOptions };
export { GlobeWalletClient };

// Re-export everything the generated client exposes (types, errors, Result,
// AssembledTransaction, etc.) so consumers never need to depend on the
// bindings package directly — it is an internal implementation detail that
// can be regenerated or restructured without being a breaking change here,
// as long as this file's exports stay stable.
export * from "@globe-wallet/bindings-globe-wallet";

/**
 * Known deployments. The bindings themselves are generated from the built
 * contract wasm (see `packages/bindings/globe-wallet` and
 * `.github/workflows/contract-bindings.yml`), so they describe the
 * contract's *interface*, not where it's deployed — this mapping is the
 * SDK's own record of that, kept in sync by hand with
 * `backend/.env.example`'s `GLOBE_WALLET_CONTRACT_ID`.
 */
export const globeWalletNetworks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K",
  },
} as const;

export type GlobeWalletNetwork = keyof typeof globeWalletNetworks;

/**
 * Create a ready-to-use `GlobeWalletClient` for a known network (currently
 * `"testnet"`, the only network the contract is deployed to — see
 * `backend/.env.example`'s `GLOBE_WALLET_CONTRACT_ID`).
 *
 * @example
 * ```ts
 * import { createGlobeWalletClient } from "@globe-wallet/sdk";
 *
 * const client = createGlobeWalletClient("testnet", {
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 * });
 * const { result: assets } = await client.get_assets({ user: "G..." });
 * ```
 */
export function createGlobeWalletClient(
  network: GlobeWalletNetwork,
  options: Partial<GlobeWalletClientOptions> & { rpcUrl: string }
): GlobeWalletClient {
  const net = globeWalletNetworks[network];
  return new GlobeWalletClient({
    contractId: net.contractId,
    networkPassphrase: net.networkPassphrase,
    ...options,
  });
}

/**
 * Client-side validation mirroring the backend's rules (#103): address
 * format, issued-asset/path-payment format, memo byte length, amount
 * decimals.
 */
export * from "./validate/index.js";

/**
 * Shared display formatting for amounts, assets and addresses (#102), so
 * web and mobile can't drift into inconsistent decimals/truncation.
 */
export * from "./format/index.js";

/**
 * Address-poisoning detection (#104): flag destinations that look like a
 * recent contact/counterparty but differ.
 */
export * from "./security/index.js";

/**
 * Typed HTTP client for the backend REST API (#18), generated from
 * `backend/openapi.yaml` via `openapi-typescript` and transported with
 * `openapi-fetch`. Use `createClient({ baseUrl, getToken, onSessionExpired })`
 * to get a fully typed client that injects the auth header and normalises
 * the backend error envelope. Works in Node 20, browsers and React Native
 * (no Node-only APIs in the runtime path).
 */
export * from "./client/index.js";
