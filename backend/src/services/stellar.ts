import * as StellarSdk from "@stellar/stellar-sdk";
import { NotFoundError, ValidationError } from "../errors/appError";
import { config } from "../config";
import { validatePathAssets } from "../validation/stellarAsset";
import { AccountLock, InProcessAccountLock } from "./locks/accountLock";
import {
  MemoRequiredError,
  NonRetryableHorizonError,
  SequenceConflictError,
} from "./stellarErrors";
import type { TransactionSummary } from "@stellar-global-wallet/types";
import { PaymentFlag, computePaymentFlags, parseVerifiedAssetsList } from "./paymentFlags";
import { verifiedAssetKeys } from "./verifiedAssets";

// Re-exported for backward compatibility — this used to be declared locally
// here. The canonical definition now lives in packages/types (issue #107)
// so it can be shared with future SDK/client packages.
export type { TransactionSummary };

/**
 * One payment-shaped item in an account's activity feed (#105). Backed by
 * Horizon's `/payments` endpoint (operation records), joined with their
 * parent transaction so `memo` comes back in the same request instead of
 * one extra Horizon call per item.
 *
 * `amount`/`asset_*`/`from`/`to` are only present for operation types that
 * actually carry a single asset amount (payments and path payments); other
 * activity (e.g. `create_account`) still shows up so the feed is complete,
 * just without those fields and without "dust"/"unknown_asset" flags,
 * which need an amount+asset to evaluate.
 */
export interface PaymentHistoryItem {
  id: string;
  type: string;
  transactionHash: string;
  createdAt: string;
  from: string | undefined;
  to: string | undefined;
  amount: string | undefined;
  assetType: string | undefined;
  assetCode: string | undefined;
  assetIssuer: string | undefined;
  memo: string | undefined;
  flags: PaymentFlag[];
}

/** Maximum number of tx_bad_seq retries before giving up. */
const MAX_SEQ_RETRIES = 3;

/** How many ms to pause between retries (exponential back-off seed). */
const RETRY_BASE_DELAY_MS = 200;

export class StellarService {
  private server: StellarSdk.Horizon.Server;
  private networkPassphrase: string;
  private readonly accountLock: AccountLock;

  constructor(accountLock: AccountLock = new InProcessAccountLock()) {
    this.networkPassphrase = config.NETWORK_PASSPHRASE;
    this.server = new StellarSdk.Horizon.Server(config.HORIZON_URL);
    this.accountLock = accountLock;
  }

  generateKeypair(): StellarSdk.Keypair {
    return StellarSdk.Keypair.random();
  }

  async getAccount(publicKey: string) {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (err) {
      if (hasResponseStatus(err, 404)) {
        throw new NotFoundError(`Account ${publicKey} was not found on Horizon`, "ACCOUNT_NOT_FOUND");
      }
      throw err;
    }
  }

  async getBalances(publicKey: string): Promise<Record<string, string>> {
    const account = await this.getAccount(publicKey);
    const result: Record<string, string> = {};
    for (const b of account.balances) {
      if (b.asset_type === "native") result["XLM"] = b.balance;
      else if ("asset_code" in b) result[b.asset_code] = b.balance;
    }
    return result;
  }

  async getTransactions(
    publicKey: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{
    transactions: TransactionSummary[];
    next: string | undefined;
    hasMore: boolean;
  }>;
  async getTransactions(publicKey: string, limit: number): Promise<TransactionSummary[]>;
  async getTransactions(
    publicKey: string,
    optionsOrLimit?: { limit?: number; cursor?: string } | number
  ) {
    let limit = 20;
    let cursor: string | undefined;
    if (typeof optionsOrLimit === "number") {
      limit = optionsOrLimit;
    } else if (typeof optionsOrLimit === "object" && optionsOrLimit !== null) {
      limit = optionsOrLimit.limit ?? 20;
      cursor = optionsOrLimit.cursor;
    }

    let builder = this.server
      .transactions()
      .forAccount(publicKey)
      .limit(limit)
      .order("desc");
    if (cursor) {
      builder = builder.cursor(cursor);
    }
    const records = await builder.call();
    const transactions: TransactionSummary[] = records.records.map((tx) => ({
      id: tx.id,
      hash: tx.hash,
      ledger: tx.ledger_attr,
      created_at: tx.created_at,
      operation_count: tx.operation_count,
      memo: tx.memo,
    }));
    const lastRecord = records.records[records.records.length - 1];
    const result = {
      transactions,
      next: lastRecord ? (lastRecord as unknown as { paging_token: string }).paging_token : undefined,
      hasMore: records.records.length === limit,
    };

    if (typeof optionsOrLimit === "number") {
      return transactions;
    }
    return result;
  }

  /**
   * Account activity feed with suspicious-payment heuristics applied (#105).
   *
   * Backed by Horizon's `/payments` endpoint rather than `/transactions`:
   * payments carry `amount`/`asset_*`/`from`/`to` directly, which is what
   * the dust/unknown-asset heuristics need and what `getTransactions`'s
   * transaction-level records don't have. `.join("transactions")` pulls
   * each operation's parent transaction (for `memo`) into the same Horizon
   * request instead of one extra round trip per item.
   */
  async getPaymentHistory(
    publicKey: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{
    payments: PaymentHistoryItem[];
    next: string | undefined;
    hasMore: boolean;
  }> {
    const limit = options?.limit ?? 20;
    const cursor = options?.cursor;

    let builder = this.server
      .payments()
      .forAccount(publicKey)
      .join("transactions")
      .limit(limit)
      .order("desc");
    if (cursor) {
      builder = builder.cursor(cursor);
    }
    const records = await builder.call();

    const dustThreshold = config.SPAM_DUST_THRESHOLD;
    // Curated list (#54) plus any per-deployment VERIFIED_ASSETS additions.
    const verifiedAssets = new Set([
      ...verifiedAssetKeys(),
      ...parseVerifiedAssetsList(config.VERIFIED_ASSETS),
    ]);

    const payments: PaymentHistoryItem[] = await Promise.all(
      records.records.map(async (op) => {
        // Only payment-shaped operations carry a single amount+asset;
        // everything else (create_account, account_merge, ...) still shows
        // up in the feed but without these fields — see PaymentHistoryItem.
        const amount = "amount" in op ? op.amount : undefined;
        const assetType = "asset_type" in op ? op.asset_type : undefined;
        const assetCode = "asset_code" in op ? op.asset_code : undefined;
        const assetIssuer = "asset_issuer" in op ? op.asset_issuer : undefined;
        const from = "from" in op ? op.from : undefined;
        const to = "to" in op ? op.to : undefined;

        // Joined above, so this resolves from the already-fetched response
        // rather than making a second Horizon request per item.
        let memo: string | undefined;
        try {
          const transaction = await op.transaction();
          memo = transaction.memo;
        } catch (err) {
          console.warn(`[stellar] failed to read joined transaction for operation ${op.id}: ${err}`);
        }

        const flags = computePaymentFlags(
          { amount, assetType, assetCode, assetIssuer, memo },
          { dustThreshold, verifiedAssets }
        );

        return {
          id: op.id,
          type: op.type,
          transactionHash: op.transaction_hash,
          createdAt: op.created_at,
          from,
          to,
          amount,
          assetType,
          assetCode,
          assetIssuer,
          memo,
          flags,
        };
      })
    );

    const lastRecord = records.records[records.records.length - 1];
    return {
      payments,
      next: lastRecord ? (lastRecord as unknown as { paging_token: string }).paging_token : undefined,
      hasMore: records.records.length === limit,
    };
  }

  /**
   * Check whether a destination account requires a memo (SEP-29).
   * Accounts signal memo requirements by storing a data entry with the key
   * "config.memo_required" set to the value "MQ==". This is the standard
   * on-chain mechanism used by exchanges and custodial wallets.
   */
  async destinationRequiresMemo(publicKey: string): Promise<boolean> {
    try {
      const account = await this.getAccount(publicKey);
      const data = account.data_attr as Record<string, string> | undefined;
      if (data && data["config.memo_required"] === "MQ==") {
        return true;
      }
      return false;
    } catch {
      // If the account doesn't exist on the network, we can't check —
      // let the send proceed and Horizon will reject if needed.
      return false;
    }
  }
  // ---------------------------------------------------------------------------
  //  Issue #9 – Automatic resubmission after tx_bad_seq
  // ---------------------------------------------------------------------------
  // When Horizon rejects a submission with tx_bad_seq the source account's
  // sequence number moved between read and submission.  Rather than surfacing
  // a raw error we re-fetch the account, rebuild the transaction from the
  // fresh sequence number and try again – bounded to MAX_SEQ_RETRIES attempts
  // with exponential back-off.  Any *other* Horizon result code (e.g.
  // op_underfunded) is never retried because it indicates a deterministic
  // failure that a fresh sequence number cannot fix.
  // ---------------------------------------------------------------------------

  private async submitWithSeqRetry(
    sourcePublicKey: string,
    sourceKeypair: StellarSdk.Keypair,
    methodName: string,
    buildTransactionBuilder: (account: StellarSdk.Account) => StellarSdk.TransactionBuilder
  ) {
    return this.accountLock.withLock(sourcePublicKey, async () => {
      let lastAttemptError: unknown;
      for (let attempt = 0; attempt <= MAX_SEQ_RETRIES; attempt++) {
        if (attempt > 0) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          const prefix = methodName === "sendPayment" ? "" : `${methodName} `;
          const suffix = methodName === "sendPayment" ? " before resubmit" : "";
          console.log(
            `[stellar] ${prefix}tx_bad_seq retry ${attempt}/${MAX_SEQ_RETRIES} ` +
              `for ${sourcePublicKey} — waiting ${delay}ms${suffix}`
          );
          await new Promise((r) => setTimeout(r, delay));
        }

        const sourceAccount = await this.getAccount(sourcePublicKey);
        const builder = buildTransactionBuilder(sourceAccount);
        const tx = builder.build();
        tx.sign(sourceKeypair);

        try {
          const result = await this.server.submitTransaction(tx);
          if (attempt > 0) {
            const prefix = methodName === "sendPayment" ? "" : `${methodName} `;
            console.log(
              `[stellar] ${prefix}tx_bad_seq retry ${attempt}/${MAX_SEQ_RETRIES} ` +
                `succeeded for ${sourcePublicKey}`
            );
          }
          return result;
        } catch (err) {
          if (isTxBadSeq(err) && attempt < MAX_SEQ_RETRIES) {
            lastAttemptError = err;
            continue;
          }
          throw translateSubmissionError(err, sourcePublicKey);
        }
      }
      throw translateSubmissionError(lastAttemptError, sourcePublicKey);
    });
  }

  async sendPayment(params: {
    sourceSecretKey: string;
    destinationPublicKey: string;
    amount: string;
    asset?: string;
    memo?: string;
  }) {
    const { sourceSecretKey, destinationPublicKey, amount, asset, memo } = params;
    const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecretKey);
    const sourcePublicKey = sourceKeypair.publicKey();

    // SEP-29: check whether the destination account requires a memo before
    // building the transaction. This prevents accidental fund loss when
    // sending to custodial/exchange accounts that rely on the memo to
    // credit the deposit.
    const requiresMemo = await this.destinationRequiresMemo(destinationPublicKey);
    if (requiresMemo && !memo) {
      throw new MemoRequiredError(
        `The destination account ${destinationPublicKey} requires a memo for transactions. ` +
          "Please provide a memo to avoid losing funds. (SEP-29)"
      );
    }

    // Two concurrent sends from the same source account both read the same
    // starting sequence number and race on submission: the loser gets a
    // bare Horizon tx_bad_seq. Serializing per source account here — load
    // account, build, sign, submit as one atomic unit of work — means each
    // submission always starts from the sequence number left behind by the
    // previous one instead of a stale read. See docs/concurrency.md for
    // why this only holds within a single process and what closes the gap
    // across multiple instances.
    return this.submitWithSeqRetry(
      sourcePublicKey,
      sourceKeypair,
      "sendPayment",
      (sourceAccount) => {
        const stellarAsset =
          !asset || asset === "XLM"
            ? StellarSdk.Asset.native()
            : new StellarSdk.Asset(asset.split(":")[0], asset.split(":")[1]);
        const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination: destinationPublicKey,
              asset: stellarAsset,
              amount,
            })
          )
          .setTimeout(30);
        if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
        return builder;
      }
    );
  }

  // ---------------------------------------------------------------------------
  //  Issue #7 – Path payments (strict-send / strict-receive)
  // ---------------------------------------------------------------------------

  async pathPaymentStrictSend(params: {
    sourceSecretKey: string;
    destinationPublicKey: string;
    sendAmount: string;
    destAsset: string;
    destMin: string;
    path?: string[];
    memo?: string;
  }) {
    const {
      sourceSecretKey,
      destinationPublicKey,
      sendAmount,
      destAsset,
      destMin,
      path,
      memo,
    } = params;
    const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecretKey);
    const sourcePublicKey = sourceKeypair.publicKey();

    return this.submitWithSeqRetry(
      sourcePublicKey,
      sourceKeypair,
      "pathPaymentStrictSend",
      (sourceAccount) => {
        const destinationAsset = parseAsset(destAsset);
        const strictSendPath = parsePathAssets(path);

        const op = StellarSdk.Operation.pathPaymentStrictSend({
          destination: destinationPublicKey,
          sendAsset: StellarSdk.Asset.native(),
          sendAmount,
          destAsset: destinationAsset,
          destMin,
          path: strictSendPath,
        });

        const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        }).addOperation(op).setTimeout(30);

        if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
        return builder;
      }
    );
  }

  async pathPaymentStrictReceive(params: {
    sourceSecretKey: string;
    destinationPublicKey: string;
    destAmount: string;
    destAsset: string;
    sendMax: string;
    path?: string[];
    memo?: string;
  }) {
    const {
      sourceSecretKey,
      destinationPublicKey,
      destAmount,
      destAsset,
      sendMax,
      path,
      memo,
    } = params;
    const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecretKey);
    const sourcePublicKey = sourceKeypair.publicKey();

    return this.submitWithSeqRetry(
      sourcePublicKey,
      sourceKeypair,
      "pathPaymentStrictReceive",
      (sourceAccount) => {
        const destinationAsset = parseAsset(destAsset);
        const strictReceivePath = parsePathAssets(path);

        const op = StellarSdk.Operation.pathPaymentStrictReceive({
          destination: destinationPublicKey,
          sendAsset: StellarSdk.Asset.native(),
          sendMax,
          destAsset: destinationAsset,
          destAmount,
          path: strictReceivePath,
        });

        const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        }).addOperation(op).setTimeout(30);

        if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
        return builder;
      }
    );
  }

  // ---------------------------------------------------------------------------
  //  Issue #7 helper – Horizon path-finding
  // ---------------------------------------------------------------------------
  // Uses the flat `strictSendPaths(sourceAsset, sourceAmount, destination)` /
  // `strictReceivePaths(source, destinationAsset, destinationAmount)` methods
  // on `Horizon.Server` (issue #70) — there is no chained `.paths().strictSend()`
  // builder in @stellar/stellar-sdk.
  // ---------------------------------------------------------------------------

  async findStrictSendPaths(params: {
    sourceAmount: string;
    sourceAsset?: string;
    destinationAsset: string;
    destinationPublicKey?: string;
  }): Promise<unknown[]> {
    const { sourceAmount, sourceAsset, destinationAsset, destinationPublicKey } = params;
    const srcAsset = sourceAsset ? parseAsset(sourceAsset) : StellarSdk.Asset.native();
    const destAst = parseAsset(destinationAsset);
    const destination = destinationPublicKey ?? [destAst];

    const query = this.server.strictSendPaths(srcAsset, sourceAmount, destination).limit(5);

    const result = await query.call();
    return result.records as unknown[];
  }

  async findStrictReceivePaths(params: {
    destinationAmount: string;
    destinationAsset: string;
    sourceAsset?: string;
    destinationPublicKey?: string;
  }): Promise<unknown[]> {
    const { destinationAmount, destinationAsset, sourceAsset, destinationPublicKey } = params;
    const destAst = parseAsset(destinationAsset);
    const srcAsset = sourceAsset ? parseAsset(sourceAsset) : StellarSdk.Asset.native();
    const source = destinationPublicKey ?? [srcAsset];

    const query = this.server.strictReceivePaths(source, destAst, destinationAmount).limit(5);

    const result = await query.call();
    return result.records as unknown[];
  }

  // ---------------------------------------------------------------------------
  //  Issue #8 – Multi-signature / threshold signing
  // ---------------------------------------------------------------------------

  /**
   * Builds a payment transaction, signs it with the provided secret key, and
   * returns the base64-encoded XDR so that co-signers can add their
   * signatures before final submission.
   */
  async buildPartialTransaction(params: {
    sourceSecretKey: string;
    destinationPublicKey: string;
    amount: string;
    asset?: string;
    memo?: string;
  }): Promise<{ xdr: string; hash: string }> {
    const { sourceSecretKey, destinationPublicKey, amount, asset, memo } = params;
    const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecretKey);
    const sourcePublicKey = sourceKeypair.publicKey();

    return this.accountLock.withLock(sourcePublicKey, async () => {
      const sourceAccount = await this.getAccount(sourcePublicKey);
      const stellarAsset = parseAsset(asset);

      const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: destinationPublicKey,
            asset: stellarAsset,
            amount,
          })
        )
        .setTimeout(30);

      if (memo) builder.addMemo(StellarSdk.Memo.text(memo));

      const tx = builder.build();
      tx.sign(sourceKeypair);

      return {
        xdr: tx.toXDR(),
        hash: tx.hash().toString("hex"),
      };
    });
  }

  /**
   * Wraps a previously signed transaction in a fee-bump envelope (CAP-15).
   * The inner transaction's signatures are untouched — only the outer
   * fee-bump envelope is signed with the fee source's key. This lets callers
   * rescue a stuck transaction whose base fee was too low for network
   * congestion, without re-signing the inner transaction or changing the
   * sequence number.
   *
   * Built via `StellarSdk.TransactionBuilder.buildFeeBumpTransaction(...)`
   * (issue #69) — `FeeBumpTransaction` itself is a class with a positional
   * `(envelope, networkPassphrase)` constructor, not an options-object
   * factory function, so it cannot be called directly with
   * `{ innerTransaction, fee, feeSource }`.
   */
  async feeBumpTransaction(params: {
    transactionXdr: string;
    feeSecretKey: string;
    fee?: string;
  }) {
    const { transactionXdr, feeSecretKey, fee } = params;
    const feeKeypair = StellarSdk.Keypair.fromSecret(feeSecretKey);
    const feePublicKey = feeKeypair.publicKey();

    const innerTx = new StellarSdk.Transaction(
      transactionXdr,
      this.networkPassphrase
    );

    const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
      feePublicKey,
      fee ?? String(Number(StellarSdk.BASE_FEE) * 100),
      innerTx,
      this.networkPassphrase
    );

    feeBumpTx.sign(feeKeypair);

    try {
      return await this.server.submitTransaction(feeBumpTx);
    } catch (err) {
      throw translateSubmissionError(err, feePublicKey);
    }
  }

  /**
   * Merges additional signer signatures into a partially-signed transaction
   * XDR and submits the result to Horizon.  Callers provide the base64 XDR
   * returned by `buildPartialTransaction` plus one or more additional
   * secret keys whose signatures satisfy the remaining threshold weight.
   */
  async submitWithAdditionalSignatures(params: {
    xdr: string;
    signerSecretKeys: string[];
  }): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    const { xdr, signerSecretKeys } = params;
    const tx = new StellarSdk.Transaction(xdr, this.networkPassphrase);

    for (const sk of signerSecretKeys) {
      tx.sign(StellarSdk.Keypair.fromSecret(sk));
    }

    try {
      return await this.server.submitTransaction(tx);
    } catch (err) {
      const sourcePublicKey = tx.source;
      throw translateSubmissionError(err, sourcePublicKey);
    }
  }

  /**
   * Returns threshold information for the given account so callers can
   * determine how many additional signers are required before a
   * multi-sig transaction can be submitted.
   */
  async getAccountThresholds(publicKey: string): Promise<{
    lowThreshold: number;
    mediumThreshold: number;
    highThreshold: number;
    signers: Array<{ key: string; weight: number }>;
  }> {
    const account = await this.getAccount(publicKey);
    return {
      lowThreshold: account.thresholds.low_threshold,
      mediumThreshold: account.thresholds.med_threshold,
      highThreshold: account.thresholds.high_threshold,
      signers: (account as unknown as { signers?: Array<{ key: string; weight: number }> }).signers ?? [],
    };
  }
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function parseAsset(assetStr: string | undefined): StellarSdk.Asset {
  if (!assetStr || assetStr === "XLM") return StellarSdk.Asset.native();
  const [code, issuer] = assetStr.split(":");
  return new StellarSdk.Asset(code, issuer);
}

function parsePathAssets(path: string[] | undefined): StellarSdk.Asset[] {
  let pathAssets: string[];

  try {
    pathAssets = validatePathAssets(path);
  } catch (error) {
    throw new ValidationError([
      {
        location: "body",
        message: error instanceof Error ? error.message : "Invalid path",
        path: "path",
        value: path,
      },
    ]);
  }

  return pathAssets.map((asset) => parseAsset(asset));
}

function isTxBadSeq(err: unknown): boolean {
  if (!(err instanceof StellarSdk.BadResponseError)) return false;
  const resultCodes = (err.response as { extras?: { result_codes?: unknown } } | undefined)
    ?.extras?.result_codes as { transaction?: string } | undefined;
  return resultCodes?.transaction === "tx_bad_seq";
}

function hasResponseStatus(err: unknown, status: number): boolean {
  const response = err as { response?: { status?: number } } | undefined;
  return response?.response?.status === status;
}

function translateSubmissionError(err: unknown, sourcePublicKey: string): unknown {
  if (err instanceof StellarSdk.BadResponseError) {
    const resultCodes = (err.response as { extras?: { result_codes?: unknown } } | undefined)
      ?.extras?.result_codes as { transaction?: string; operations?: string[] } | undefined;

    if (resultCodes?.transaction === "tx_bad_seq") {
      return new SequenceConflictError(
        `Payment for account ${sourcePublicKey} was rejected because its sequence ` +
          "number changed between read and submission (tx_bad_seq). This request's " +
          "funds were NOT moved. This should be rare with in-process locking enabled " +
          "— if you're seeing it repeatedly, check whether more than one instance of " +
          "this service is running without LOCK_BACKEND=redis (see docs/concurrency.md). " +
          "Safe to retry.",
        resultCodes
      );
    }

    // Classify non-retryable Horizon errors so the caller knows the error
    // is deterministic and retrying won't help.
    const message = (err as Error).message ?? "Horizon submission failed";
    return new NonRetryableHorizonError(
      `Horizon rejected the transaction for account ${sourcePublicKey}: ${message}`,
      resultCodes
    );
  }
  return err;
}
