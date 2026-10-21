import * as StellarSdk from "@stellar/stellar-sdk";
import { InvalidTransactionError, TransactionExpiredError } from "./stellarErrors";

/**
 * How long an unsigned transaction stays valid. Long enough for a user to
 * review it and approve the wallet prompt, short enough that an abandoned
 * XDR can't be submitted later.
 */
export const BUILD_TIMEOUT_SECONDS = 180;

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

/** A submitted transaction the network accepted. */
export interface SubmitSignedResult {
  hash: string;
  ledger: number;
  successful: boolean;
}

/**
 * The network didn't answer in time (Horizon 504, or Soroban RPC still
 * reporting NOT_FOUND). The transaction may yet land, so the client should
 * poll for `hash` rather than rebuild.
 */
export interface SubmitSignedPending {
  hash: string;
  status: "pending";
}

export type AnyTransaction = StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;

export interface ParsedSignedTransaction {
  transaction: AnyTransaction;
  /** Hex transaction hash (of the fee-bump envelope when there is one). */
  hash: string;
  /** G... account whose sequence number is consumed — scopes idempotency keys. */
  sourcePublicKey: string;
}

function innerTransaction(tx: AnyTransaction): StellarSdk.Transaction {
  return "innerTransaction" in tx ? tx.innerTransaction : tx;
}

/**
 * Rejects an envelope whose signature from `signerAddress` doesn't verify
 * under the API's network passphrase. The passphrase is hashed into what is
 * signed, so an envelope signed for another network (testnet vs public)
 * parses fine here but fails this check. Only signatures whose hint matches
 * the signer are checked: other co-signers' keys aren't known without
 * loading the account, so those are left for Horizon to judge.
 */
function assertSignedForThisNetwork(tx: AnyTransaction, signerAddress: string): void {
  const signer = StellarSdk.Keypair.fromPublicKey(baseAccountId(signerAddress));
  const hint = Buffer.from(signer.signatureHint());
  const candidates = tx.signatures.filter((sig) => Buffer.from(sig.hint()).equals(hint));
  if (candidates.length === 0) return;

  const hash = tx.hash();
  if (!candidates.some((sig) => signer.verify(hash, sig.signature()))) {
    throw new InvalidTransactionError(
      "The signature does not verify for this network. The transaction was signed for a different " +
        "network passphrase than the one this API uses.",
      "WRONG_NETWORK"
    );
  }
}

/**
 * Parses a client-signed envelope and rejects it if it can't be valid:
 * malformed XDR, no signatures (a fee-bump needs both its own and the inner
 * transaction's), or signed for a different network. Does not check expiry —
 * see {@link assertNotExpired}, which callers run after any idempotent replay.
 */
export function parseSignedTransaction(signedXdr: string, networkPassphrase: string): ParsedSignedTransaction {
  let transaction: AnyTransaction;
  try {
    transaction = StellarSdk.TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    throw new InvalidTransactionError("signedXdr is not a valid transaction envelope.", "MALFORMED_XDR");
  }

  const inner = innerTransaction(transaction);
  if (transaction.signatures.length === 0 || inner.signatures.length === 0) {
    throw new InvalidTransactionError("The transaction has not been signed.", "UNSIGNED");
  }

  if ("innerTransaction" in transaction) {
    assertSignedForThisNetwork(transaction, transaction.feeSource);
  }
  assertSignedForThisNetwork(inner, inner.source);

  return {
    transaction,
    hash: transaction.hash().toString("hex"),
    sourcePublicKey: baseAccountId(inner.source),
  };
}

/** Fails fast with TX_EXPIRED when `timeBounds.maxTime` is already in the past. */
export function assertNotExpired(tx: AnyTransaction, now: number = Date.now()): void {
  const maxTime = innerTransaction(tx).timeBounds?.maxTime ?? "0";
  if (maxTime !== "0" && Number(maxTime) * 1000 <= now) {
    const expiredAt = new Date(Number(maxTime) * 1000).toISOString();
    throw new TransactionExpiredError(
      `The transaction expired at ${expiredAt}. Build a new one and sign it again.`,
      expiredAt
    );
  }
}
