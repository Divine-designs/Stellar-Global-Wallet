import * as StellarSdk from "@stellar/stellar-sdk";

export const TEST_PASSPHRASE = process.env.NETWORK_PASSPHRASE as string;

export interface SignedPaymentOptions {
  keypair?: StellarSdk.Keypair;
  networkPassphrase?: string;
  /** Unix seconds for `timeBounds.maxTime`; defaults to 180 seconds from now. */
  maxTime?: number;
  /** Leave the envelope unsigned. */
  unsigned?: boolean;
}

/** A payment signed in the test with a throwaway keypair, the way a wallet would. */
export function signedPayment(options: SignedPaymentOptions = {}) {
  const keypair = options.keypair ?? StellarSdk.Keypair.random();
  const passphrase = options.networkPassphrase ?? TEST_PASSPHRASE;
  const builder = new StellarSdk.TransactionBuilder(new StellarSdk.Account(keypair.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: passphrase,
  }).addOperation(
    StellarSdk.Operation.payment({
      destination: StellarSdk.Keypair.random().publicKey(),
      asset: StellarSdk.Asset.native(),
      amount: "5",
    })
  );
  if (options.maxTime !== undefined) builder.setTimebounds(0, options.maxTime);
  else builder.setTimeout(180);

  const tx = builder.build();
  if (!options.unsigned) tx.sign(keypair);
  return { keypair, tx, xdr: tx.toXDR(), hash: tx.hash().toString("hex") };
}

/** Wraps a signed transaction in a fee-bump envelope signed by `feePayer`. */
export function feeBumped(inner: StellarSdk.Transaction, feePayer: StellarSdk.Keypair, passphrase = TEST_PASSPHRASE) {
  const bump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(feePayer.publicKey(), "200", inner, passphrase);
  bump.sign(feePayer);
  return { tx: bump, xdr: bump.toXDR(), hash: bump.hash().toString("hex") };
}

/** The error Horizon's SDK throws when a submission is rejected with result codes. */
export function horizonRejection(resultCodes: { transaction: string; operations?: string[] }) {
  return new StellarSdk.BadResponseError("Transaction submission failed", {
    type: "https://stellar.org/horizon-errors/transaction_failed",
    title: "Transaction Failed",
    status: 400,
    extras: { result_codes: resultCodes, result_xdr: "" },
  });
}
