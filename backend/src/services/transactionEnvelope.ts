import * as StellarSdk from "@stellar/stellar-sdk";

/**
 * What a build endpoint returns for a transaction the client is about to
 * sign: the unsigned envelope plus everything a wallet UI needs to show
 * before asking for a signature (network, fee, expiry).
 */
export interface UnsignedTransactionInfo {
  /** Base64 XDR of the unsigned transaction envelope. */
  xdr: string;
  /** Passphrase the wallet must sign against — must match the API's network. */
  networkPassphrase: string;
  /** Total fee in stroops (base fee x operation count). */
  fee: string;
  /** Sequence number the transaction uses. Not reserved: two builds in a row share it. */
  sequence: string;
  /** Unix seconds as strings; `maxTime` of "0" means no expiry. */
  timeBounds: { minTime: string; maxTime: string };
  /** ISO timestamp of `timeBounds.maxTime`, or null when the transaction never expires. */
  expiresAt: string | null;
}

export function describeUnsignedTransaction(
  tx: StellarSdk.Transaction,
  networkPassphrase: string
): UnsignedTransactionInfo {
  const timeBounds = { minTime: tx.timeBounds?.minTime ?? "0", maxTime: tx.timeBounds?.maxTime ?? "0" };
  return {
    xdr: tx.toXDR(),
    networkPassphrase,
    fee: tx.fee,
    sequence: tx.sequence,
    timeBounds,
    expiresAt: timeBounds.maxTime === "0" ? null : new Date(Number(timeBounds.maxTime) * 1000).toISOString(),
  };
}

/**
 * The underlying G... account of a G... or muxed M... address. Existence,
 * trustline and SEP-29 checks run against the base account; the muxed ID
 * only matters in the operation's destination field.
 */
export function baseAccountId(address: string): string {
  return address.startsWith("M")
    ? StellarSdk.MuxedAccount.fromAddress(address, "0").baseAccount().accountId()
    : address;
}
