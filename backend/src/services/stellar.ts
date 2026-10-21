import * as StellarSdk from "@stellar/stellar-sdk";
import { AppError, NotFoundError, ValidationError } from "../errors/appError";
import { config } from "../config";
import { validatePathAssets } from "../validation/stellarAsset";
import { AccountLock, InProcessAccountLock } from "./locks/accountLock";
import {
  DestinationNotFundedError,
  DestinationTrustlineError,
  MemoRequiredError,
  NonRetryableHorizonError,
  PathExpiredError,
  SequenceConflictError,
  SourceAccountNotFoundError,
  TransactionAlreadySubmittedError,
  TransactionExpiredError,
} from "./stellarErrors";
import {
  assertNotExpired,
  baseAccountId,
  BUILD_TIMEOUT_SECONDS,
  describeUnsignedTransaction,
  ParsedSignedTransaction,
  parseSignedTransaction,
  SubmitSignedPending,
  SubmitSignedResult,
  UnsignedTransactionInfo,
} from "./transactionEnvelope";
import type { TransactionSummary } from "@stellar-global-wallet/types";
import { fromStroops, toStroops } from "../utils/stroops";
import { isGAddress } from "../utils/stellarAddress";

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

/**
 * Minimum starting balance for a brand-new account: the base reserve (0.5
 * XLM) x 2 base entries. `createAccount` with less than this fails on-chain
 * with `op_low_reserve` (#65).
 */
export const MIN_STARTING_BALANCE = "1";

/** Base reserve per ledger entry, in XLM. */
const BASE_RESERVE = "0.5";

/** Which operation the send/build path chose for a destination (#65). */
export type SendOperationType = "payment" | "createAccount";

/** Unsigned path payment plus what the swap screen shows before the user signs. */
export interface PathPaymentBuild extends UnsignedTransactionInfo {
  /** Amounts in the send / receive asset, as 7-decimal strings. */
  expectedSend: string;
  expectedReceive: string;
  /** Strict-send only: the least the destination will receive (`destMin`). */
  minReceive?: string;
  /** Strict-receive only: the most the source will spend (`sendMax`). */
  maxSend?: string;
  slippageBps: number;
  path: string[];
}

/** One pre-signing warning returned by `precheckSend` (#64). */
export interface SendPrecheckWarning {
  code:
    | "DESTINATION_IS_SOURCE"
    | "SOURCE_NOT_FUNDED"
    | "DESTINATION_NOT_FUNDED"
    | "DESTINATION_WILL_BE_CREATED"
    | "NO_TRUSTLINE"
    | "TRUSTLINE_NOT_AUTHORIZED"
    | "MEMO_REQUIRED"
    | "AMOUNT_EXCEEDS_SPENDABLE";
  message: string;
  /** True when submitting as-is would certainly fail or lose funds. */
  blocking: boolean;
}

export interface SendPrecheckResult {
  warnings: SendPrecheckWarning[];
  /** True when any warning is blocking — clients should not offer "Sign". */
  blocking: boolean;
  /** Operation the build endpoints would use for this destination. */
  operationType: SendOperationType;
  /** Source's spendable balance of `asset`, or undefined if the source is unfunded. */
  spendable: string | undefined;
}

/** Raw Horizon `/payments` record plus its joined parent transaction (#62). */
export interface PaymentExportRecord {
  op: StellarSdk.Horizon.ServerApi.OperationRecord;
  transaction: StellarSdk.Horizon.ServerApi.TransactionRecord | undefined;
}

/** Maximum number of tx_bad_seq retries before giving up. */
const MAX_SEQ_RETRIES = 3;

/** How many ms to pause between retries (exponential back-off seed). */
const RETRY_BASE_DELAY_MS = 200;

/** Path payment result codes that mean "the quote no longer holds" rather than a deterministic failure. */
const PATH_EXPIRED_OPERATION_CODES = ["op_too_few_offers", "op_under_dest_min", "op_over_source_max"];

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

  /** Like `getAccount`, but resolves to `null` instead of throwing on 404. */
  async loadAccountOrNull(publicKey: string): Promise<StellarSdk.Horizon.AccountResponse | null> {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (err) {
      if (hasResponseStatus(err, 404)) return null;
      throw err;
    }
  }

  /**
   * Builds an unsigned changeTrust transaction and reports its reserve impact.
   * The spendable balance uses the same reserve/liability calculation as the
   * payment precheck and includes one transaction fee.
   */
  async buildTrustlineTransaction(params: {
    account: string;
    asset: { code: string; issuer: string };
    limit?: string;
  }): Promise<{
    xdr: string;
    networkPassphrase: string;
    reserveDelta: "0.5" | "-0.5" | "0";
    spendableXlmAfter: string;
  }> {
    const { account: accountId, asset: assetInfo } = params;
    const limit = params.limit ?? "922337203685.4775807";

    if (
      !/^[A-Za-z0-9]{1,12}$/.test(assetInfo.code) ||
      assetInfo.code.toUpperCase() === "XLM" ||
      !isGAddress(assetInfo.issuer) ||
      !/^\d+(?:\.\d{1,7})?$/.test(limit)
    ) {
      throw new AppError("Trustline details are invalid", {
        code: "VALIDATION_ERROR",
        status: 400,
      });
    }

    const limitStroops = BigInt(toStroops(limit));
    const isRemoval = limitStroops === 0n;
    if ((!isRemoval && limitStroops <= 0n) || limitStroops > 9223372036854775807n) {
      throw new AppError("Trustline limit is outside the supported range", {
        code: "VALIDATION_ERROR",
        status: 400,
      });
    }

    if (assetInfo.issuer === accountId) {
      throw new AppError("An account cannot create a trustline to itself", {
        code: "VALIDATION_ERROR",
        status: 400,
      });
    }

    if (!(await this.loadAccountOrNull(assetInfo.issuer))) {
      throw new NotFoundError("The asset issuer account was not found", "ASSET_ISSUER_NOT_FOUND");
    }

    const sourceAccount = await this.getAccount(accountId);
    const asset = new StellarSdk.Asset(assetInfo.code, assetInfo.issuer);
    const trustline = (sourceAccount.balances as unknown as BalanceLine[]).find(
      (balance) =>
        (balance.asset_type === "credit_alphanum4" ||
          balance.asset_type === "credit_alphanum12") &&
        balance.asset_code === assetInfo.code &&
        balance.asset_issuer === assetInfo.issuer
    );

    if (isRemoval && !trustline) {
      throw new NotFoundError("The account does not have this trustline", "TRUSTLINE_NOT_FOUND");
    }
    if (isRemoval && trustline && BigInt(toStroops(trustline.balance)) > 0n) {
      throw new AppError("The trustline must have a zero balance before removal", {
        code: "TRUSTLINE_HAS_BALANCE",
        status: 409,
      });
    }

    const currentSpendable = BigInt(
      toStroops(spendableBalance(sourceAccount, StellarSdk.Asset.native()) ?? "0")
    );
    const removalReleasesReserve =
      isRemoval && (!trustline?.sponsor || trustline.sponsor === accountId);
    const reserveDelta = removalReleasesReserve ? -5000000n : trustline ? 0n : 5000000n;
    const spendableAfter = currentSpendable - reserveDelta;
    if (spendableAfter < 0n) {
      throw new AppError("The account does not have enough XLM for the trustline reserve", {
        code: "INSUFFICIENT_RESERVE",
        status: 422,
      });
    }

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(StellarSdk.Operation.changeTrust({ asset, limit: isRemoval ? "0" : limit }))
      .setTimeout(180)
      .build();

    return {
      xdr: transaction.toXDR(),
      networkPassphrase: this.networkPassphrase,
      reserveDelta: reserveDelta === 0n ? "0" : isRemoval ? "-0.5" : "0.5",
      spendableXlmAfter: fromStroops(spendableAfter),
    };
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
   * Display-ready, operation-level history (#59) with optional filters (#61).
   *
   * Backed by Horizon's `/accounts/:id/operations` with
   * `join=transactions` (so memo/fee/op-count arrive in the same request)
   * and `include_failed=true` (so failed transactions show up with
   * `successful: false` instead of silently disappearing). See
   * `scanHistory` for how filters interact with pagination and the scan cap.
   */
  async getHistory(
    publicKey: string,
    options: { limit?: number; cursor?: string; filters?: HistoryFilters } = {}
  ): Promise<HistoryPage> {
    return scanHistory(
      (cursor, pageSize) => this.fetchHistoryPage(publicKey, cursor, pageSize),
      {
        limit: options.limit ?? 20,
        cursor: options.cursor,
        filters: options.filters,
        scanCap: config.HISTORY_SCAN_CAP,
      }
    );
  }

  private async fetchHistoryPage(
    publicKey: string,
    cursor: string | undefined,
    pageSize: number
  ): Promise<HistoryItem[]> {
    let builder = this.server
      .operations()
      .forAccount(publicKey)
      .join("transactions")
      .includeFailed(true)
      .limit(pageSize)
      .order("desc");
    if (cursor) {
      builder = builder.cursor(cursor);
    }

    let records: StellarSdk.Horizon.ServerApi.OperationRecord[];
    try {
      records = (await builder.call()).records;
    } catch (err) {
      if (hasResponseStatus(err, 404)) {
        throw new NotFoundError(`Account ${publicKey} was not found on Horizon`, "ACCOUNT_NOT_FOUND");
      }
      if (hasResponseStatus(err, 400) && cursor) {
        throw new ValidationError([
          { location: "query", message: "cursor is not a valid history cursor", path: "cursor", value: cursor },
        ]);
      }
      throw err;
    }

    return Promise.all(
      records.map(async (op) => {
        // Joined above, so this resolves from the already-fetched response
        // rather than making a second Horizon request per item.
        let tx: HorizonTransactionLike | undefined;
        try {
          tx = (await op.transaction()) as unknown as HorizonTransactionLike;
        } catch (err) {
          console.warn(`[stellar] failed to read joined transaction for operation ${op.id}: ${err}`);
        }
        return mapOperationToHistoryItem(op as unknown as HorizonOperationLike, tx, publicKey);
      })
    );
  }

  /**
   * One transaction by hash with its decoded operations (#60). Operation
   * `direction`/`counterparty` are computed relative to `perspective`
   * (defaults to the transaction's source account).
   */
  async getTransactionDetail(hash: string, perspective?: string): Promise<TransactionDetail> {
    let tx: StellarSdk.Horizon.ServerApi.TransactionRecord;
    try {
      tx = await this.server.transactions().transaction(hash).call();
    } catch (err) {
      if (hasResponseStatus(err, 404)) {
        throw new NotFoundError(`Transaction ${hash} was not found on Horizon`, "TRANSACTION_NOT_FOUND");
      }
      throw err;
    }

    // A transaction has at most 100 operations, so one 200-record page
    // always covers it.
    const ops = await this.server
      .operations()
      .forTransaction(hash)
      .includeFailed(true)
      .limit(200)
      .call();

    const viewer = perspective ?? tx.source_account;
    const txLike = tx as unknown as HorizonTransactionLike;
    return {
      hash: tx.hash,
      ledger: tx.ledger_attr,
      createdAt: tx.created_at,
      successful: tx.successful,
      sourceAccount: tx.source_account,
      feeAccount: tx.fee_account,
      fee: stroopsToXlm(tx.fee_charged),
      maxFee: stroopsToXlm(tx.max_fee),
      memo: tx.memo ?? null,
      memoType: tx.memo_type,
      operationCount: tx.operation_count,
      perspective: viewer,
      operations: ops.records.map((op) =>
        mapOperationToHistoryItem(op as unknown as HorizonOperationLike, txLike, viewer)
      ),
      explorerUrl: explorerTxUrl(this.networkPassphrase, tx.hash),
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
      return accountRequiresMemo(account);
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
    assertMemoProvided(
      destinationPublicKey,
      await this.destinationRequiresMemo(destinationPublicKey),
      memo
    );

    // #65 — an unfunded destination needs createAccount, not payment.
    const { operation } = await this.resolveSendOperation(destinationPublicKey, asset, amount);

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
        const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(operation)
          .setTimeout(30);
        if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
        return builder;
      }
    );
  }

  // ---------------------------------------------------------------------------
  //  Issue #65 – createAccount for unfunded destinations
  // ---------------------------------------------------------------------------
  // A classic `payment` to an account that doesn't exist fails on-chain with
  // `op_no_destination` (after the fee is charged). The only way to send to a
  // new address is `createAccount`, which can only carry native XLM and needs
  // at least MIN_STARTING_BALANCE. The build/send paths call this to pick the
  // right operation automatically; anything else is rejected up-front with
  // DESTINATION_NOT_FUNDED instead of a wasted fee.
  // ---------------------------------------------------------------------------

  async resolveSendOperation(
    destinationPublicKey: string,
    asset: string | undefined,
    amount: string
  ): Promise<{ operation: StellarSdk.xdr.Operation; operationType: SendOperationType }> {
    const stellarAsset = parseAsset(asset);
    const destination = await this.loadAccountOrNull(destinationPublicKey);

    if (destination) {
      return {
        operationType: "payment",
        operation: StellarSdk.Operation.payment({
          destination: destinationPublicKey,
          asset: stellarAsset,
          amount,
        }),
      };
    }

    if (!stellarAsset.isNative()) {
      throw new DestinationNotFundedError(
        `Destination account ${destinationPublicKey} does not exist. Only XLM can be sent to a ` +
          `new account (at least ${MIN_STARTING_BALANCE} XLM, via createAccount).`,
        {
          reason: "NON_NATIVE_ASSET",
          destination: destinationPublicKey,
          minimumStartingBalance: MIN_STARTING_BALANCE,
        }
      );
    }

    if (toStroops(amount) < toStroops(MIN_STARTING_BALANCE)) {
      throw new DestinationNotFundedError(
        `Destination account ${destinationPublicKey} does not exist. Creating it requires a ` +
          `starting balance of at least ${MIN_STARTING_BALANCE} XLM.`,
        {
          reason: "BELOW_MINIMUM_STARTING_BALANCE",
          destination: destinationPublicKey,
          minimumStartingBalance: MIN_STARTING_BALANCE,
        }
      );
    }

    return {
      operationType: "createAccount",
      operation: StellarSdk.Operation.createAccount({
        destination: destinationPublicKey,
        startingBalance: amount,
      }),
    };
  }

  // ---------------------------------------------------------------------------
  //  Issue #1 – Unsigned payment XDR for client-side signing
  // ---------------------------------------------------------------------------
  // Non-custodial counterpart to `sendPayment`: runs the same destination
  // checks (SEP-29 memo, createAccount for unfunded destinations) but only
  // returns the unsigned envelope. Nothing is submitted, so no lock is taken
  // and no sequence number is reserved — two builds in a row return the same
  // sequence; whichever is signed and submitted first wins.
  // ---------------------------------------------------------------------------

  async buildPayment(params: {
    sourcePublicKey: string;
    destinationPublicKey: string;
    amount: string;
    asset?: string;
    memo?: string;
  }): Promise<UnsignedTransactionInfo & { operationType: SendOperationType }> {
    const { sourcePublicKey, destinationPublicKey, amount, asset, memo } = params;
    const sourceAccount = await this.loadSourceAccount(sourcePublicKey);

    // Lookups run against the underlying G... account when the destination
    // is muxed; only the payment operation carries the M... address.
    const baseDestination = baseAccountId(destinationPublicKey);
    assertMemoProvided(baseDestination, await this.destinationRequiresMemo(baseDestination), memo);

    const resolved = await this.resolveSendOperation(baseDestination, asset, amount);
    const operation =
      resolved.operationType === "payment" && baseDestination !== destinationPublicKey
        ? StellarSdk.Operation.payment({
            destination: destinationPublicKey,
            asset: parseAsset(asset),
            amount,
          })
        : resolved.operation;

    const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: await this.currentBaseFee(),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(BUILD_TIMEOUT_SECONDS);
    if (memo) builder.addMemo(StellarSdk.Memo.text(memo));

    return {
      ...describeUnsignedTransaction(builder.build(), this.networkPassphrase),
      operationType: resolved.operationType,
    };
  }

  // ---------------------------------------------------------------------------
  //  Issue #2 – Submit a client-signed envelope
  // ---------------------------------------------------------------------------
  // The client signed a specific sequence number, so unlike `sendPayment` this
  // never re-signs or retries with a fresh sequence: a failure is reported and
  // the client rebuilds. Plain and fee-bump envelopes are both accepted.
  // ---------------------------------------------------------------------------

  /** Parses and sanity-checks a signed envelope (see `parseSignedTransaction`) against this network. */
  parseSignedTransaction(signedXdr: string): ParsedSignedTransaction {
    return parseSignedTransaction(signedXdr, this.networkPassphrase);
  }

  async submitSigned(params: { signedXdr: string }): Promise<SubmitSignedResult | SubmitSignedPending> {
    const parsed = this.parseSignedTransaction(params.signedXdr);
    assertNotExpired(parsed.transaction);

    try {
      const response = await this.server.submitTransaction(parsed.transaction);
      return { hash: response.hash, ledger: response.ledger, successful: response.successful };
    } catch (err) {
      // A gateway timeout says nothing about whether the transaction landed.
      if (hasResponseStatus(err, 504)) return { hash: parsed.hash, status: "pending" };
      throw await this.translateSignedSubmissionError(err, parsed);
    }
  }

  private async translateSignedSubmissionError(err: unknown, parsed: ParsedSignedTransaction): Promise<unknown> {
    const resultCodes = (
      err as { response?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } } | undefined
    )?.response?.extras?.result_codes;
    const txCode = resultCodes?.transaction;

    // The SDK runs its own SEP-29 check before sending; surface it as the same
    // error /send and the build routes use instead of a 500.
    if (err instanceof StellarSdk.AccountRequiresMemoError) {
      return new MemoRequiredError(
        `The destination account ${err.accountId} requires a memo for transactions. ` +
          "Build the transaction again with a memo to avoid losing funds. (SEP-29)"
      );
    }
    if (err instanceof StellarSdk.BadResponseError) {
      if (resultCodes?.operations?.some((code) => PATH_EXPIRED_OPERATION_CODES.includes(code))) {
        return new PathExpiredError(resultCodes);
      }
      if (txCode === "tx_too_late") {
        return new TransactionExpiredError("The transaction expired before it reached the network. Build a new one and sign it again.");
      }
      // Re-sending an envelope that already landed fails with tx_bad_seq; if
      // the hash is on the ledger it's a duplicate, not a stale sequence.
      if (txCode === "tx_bad_seq" && (await this.transactionExists(parsed.hash))) {
        return new TransactionAlreadySubmittedError(parsed.hash);
      }
    }
    return translateSubmissionError(err, parsed.sourcePublicKey);
  }

  private async transactionExists(hash: string): Promise<boolean> {
    try {
      await this.server.transactions().transaction(hash).call();
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  //  Issue #3 – Unsigned path payments with server-side slippage
  // ---------------------------------------------------------------------------
  // The client passes the route it picked from /paths/* and the quoted amount;
  // `destMin` / `sendMax` are derived here from a basis-point tolerance in
  // integer stroops, so no client does the (fund-losing) rounding itself.
  // ---------------------------------------------------------------------------

  async buildPathPaymentStrictSend(params: {
    sourcePublicKey: string;
    destinationPublicKey: string;
    sendAsset?: string;
    sendAmount: string;
    destAsset: string;
    /** What /paths/strict-send quoted the destination would receive for `sendAmount`. */
    quotedDestAmount: string;
    path?: string[];
    slippageBps?: number;
    memo?: string;
  }): Promise<PathPaymentBuild> {
    const { sourcePublicKey, destinationPublicKey, sendAsset, sendAmount, destAsset, quotedDestAmount, path, memo } =
      params;
    const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const destMin = minReceiveAfterSlippage(quotedDestAmount, slippageBps);

    const operation = StellarSdk.Operation.pathPaymentStrictSend({
      sendAsset: parseAsset(sendAsset),
      sendAmount,
      destination: destinationPublicKey,
      destAsset: parseAsset(destAsset),
      destMin,
      path: parsePathAssets(path),
    });
    const unsigned = await this.buildPathPaymentTransaction({
      sourcePublicKey,
      destinationPublicKey,
      destAsset,
      memo,
      operation,
    });

    return {
      ...unsigned,
      expectedSend: fromStroops(toStroops(sendAmount)),
      expectedReceive: fromStroops(toStroops(quotedDestAmount)),
      minReceive: destMin,
      slippageBps,
      path: path ?? [],
    };
  }

  async buildPathPaymentStrictReceive(params: {
    sourcePublicKey: string;
    destinationPublicKey: string;
    sendAsset?: string;
    /** What /paths/strict-receive quoted the source would have to send for `destAmount`. */
    quotedSendAmount: string;
    destAsset: string;
    destAmount: string;
    path?: string[];
    slippageBps?: number;
    memo?: string;
  }): Promise<PathPaymentBuild> {
    const { sourcePublicKey, destinationPublicKey, sendAsset, quotedSendAmount, destAsset, destAmount, path, memo } =
      params;
    const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const sendMax = maxSendAfterSlippage(quotedSendAmount, slippageBps);

    const operation = StellarSdk.Operation.pathPaymentStrictReceive({
      sendAsset: parseAsset(sendAsset),
      sendMax,
      destination: destinationPublicKey,
      destAsset: parseAsset(destAsset),
      destAmount,
      path: parsePathAssets(path),
    });
    const unsigned = await this.buildPathPaymentTransaction({
      sourcePublicKey,
      destinationPublicKey,
      destAsset,
      memo,
      operation,
    });

    return {
      ...unsigned,
      expectedSend: fromStroops(toStroops(quotedSendAmount)),
      expectedReceive: fromStroops(toStroops(destAmount)),
      maxSend: sendMax,
      slippageBps,
      path: path ?? [],
    };
  }

  private async buildPathPaymentTransaction(params: {
    sourcePublicKey: string;
    destinationPublicKey: string;
    destAsset: string;
    memo?: string;
    operation: StellarSdk.xdr.Operation;
  }): Promise<UnsignedTransactionInfo> {
    const { sourcePublicKey, destinationPublicKey, destAsset, memo, operation } = params;
    const sourceAccount = await this.loadSourceAccount(sourcePublicKey);
    await this.assertDestinationCanReceive(destinationPublicKey, destAsset, memo);

    const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: await this.currentBaseFee(),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(BUILD_TIMEOUT_SECONDS);
    if (memo) builder.addMemo(StellarSdk.Memo.text(memo));
    return describeUnsignedTransaction(builder.build(), this.networkPassphrase);
  }

  /**
   * Pre-signing check for path payments: they fail on-chain (after the fee is
   * charged) if the destination is missing, can't hold the asset, or needs a
   * memo. Same rules as `precheckSend`, but fatal here.
   */
  private async assertDestinationCanReceive(
    destinationPublicKey: string,
    destAsset: string,
    memo: string | undefined
  ): Promise<void> {
    const baseDestination = baseAccountId(destinationPublicKey);
    const asset = parseAsset(destAsset);
    const destination = await this.loadAccountOrNull(baseDestination);

    if (!destination) {
      throw new DestinationNotFundedError(
        `Destination account ${baseDestination} does not exist, and a path payment cannot create it. ` +
          "Fund it first with a plain XLM payment.",
        {
          reason: "PATH_PAYMENT_CANNOT_CREATE",
          destination: baseDestination,
          minimumStartingBalance: MIN_STARTING_BALANCE,
        }
      );
    }
    assertMemoProvided(baseDestination, accountRequiresMemo(destination), memo);

    if (asset.isNative() || asset.getIssuer() === baseDestination) return;
    const label = asset.getCode();
    const trustline = findTrustline(destination, asset);
    if (!trustline) {
      throw new DestinationTrustlineError(
        `Destination account ${baseDestination} does not trust ${label} and cannot receive it.`,
        { reason: "NO_TRUSTLINE", destination: baseDestination, asset: destAsset }
      );
    }
    if (trustline.is_authorized === false) {
      throw new DestinationTrustlineError(
        `Destination's ${label} trustline is not authorized by the issuer.`,
        { reason: "TRUSTLINE_NOT_AUTHORIZED", destination: baseDestination, asset: destAsset }
      );
    }
  }

  /** Loads the source account for a build, or throws SOURCE_ACCOUNT_NOT_FOUND if it isn't funded. */
  private async loadSourceAccount(sourcePublicKey: string): Promise<StellarSdk.Account> {
    const account = await this.loadAccountOrNull(sourcePublicKey);
    if (!account) throw new SourceAccountNotFoundError(sourcePublicKey);
    return new StellarSdk.Account(account.accountId(), account.sequenceNumber());
  }

  /** Current per-operation fee from Horizon, falling back to the protocol minimum if unreachable. */
  private async currentBaseFee(): Promise<string> {
    try {
      return String(await this.server.fetchBaseFee());
    } catch {
      return StellarSdk.BASE_FEE;
    }
  }

  // ---------------------------------------------------------------------------
  //  Issue #64 – Pre-signing destination checks
  // ---------------------------------------------------------------------------
  // Read-only: loads the source and destination once each and reports every
  // problem that would make the send fail (or lose funds) after signing. Never
  // throws for a "bad" send — those come back as warnings — only for invalid
  // input or Horizon being unreachable.
  // ---------------------------------------------------------------------------

  async precheckSend(params: {
    sourcePublicKey: string;
    destinationPublicKey: string;
    amount: string;
    asset?: string;
    memo?: string;
  }): Promise<SendPrecheckResult> {
    const { sourcePublicKey, destinationPublicKey, amount, asset, memo } = params;
    const stellarAsset = parseAsset(asset);
    const warnings: SendPrecheckWarning[] = [];
    const assetLabel = stellarAsset.isNative() ? "XLM" : stellarAsset.getCode();

    const [source, destination] = await Promise.all([
      this.loadAccountOrNull(sourcePublicKey),
      sourcePublicKey === destinationPublicKey
        ? Promise.resolve(null)
        : this.loadAccountOrNull(destinationPublicKey),
    ]);
    const destinationAccount = sourcePublicKey === destinationPublicKey ? source : destination;

    if (sourcePublicKey === destinationPublicKey) {
      warnings.push({
        code: "DESTINATION_IS_SOURCE",
        message: "The destination is the same account you are sending from.",
        blocking: false,
      });
    }

    // --- Source: funded and has enough spendable balance -------------------
    let spendable: string | undefined;
    if (!source) {
      warnings.push({
        code: "SOURCE_NOT_FUNDED",
        message: `Source account ${sourcePublicKey} does not exist on the network.`,
        blocking: true,
      });
    } else {
      spendable = spendableBalance(source, stellarAsset);
      if (spendable === undefined) {
        warnings.push({
          code: "AMOUNT_EXCEEDS_SPENDABLE",
          message: `Source account has no ${assetLabel} balance (no trustline).`,
          blocking: true,
        });
      } else if (toStroops(amount) > toStroops(spendable)) {
        warnings.push({
          code: "AMOUNT_EXCEEDS_SPENDABLE",
          message:
            `Amount ${amount} ${assetLabel} exceeds the spendable balance of ${spendable} ` +
            `${assetLabel}` +
            (stellarAsset.isNative() ? " (after the minimum reserve and network fee)." : "."),
          blocking: true,
        });
      }
    }

    // --- Destination: exists / trustline / SEP-29 memo ----------------------
    let operationType: SendOperationType = "payment";
    if (!destinationAccount) {
      if (!stellarAsset.isNative()) {
        warnings.push({
          code: "DESTINATION_NOT_FUNDED",
          message:
            `Destination account does not exist. Only XLM (at least ${MIN_STARTING_BALANCE} XLM) ` +
            "can be sent to a new account.",
          blocking: true,
        });
      } else if (toStroops(amount) < toStroops(MIN_STARTING_BALANCE)) {
        warnings.push({
          code: "DESTINATION_NOT_FUNDED",
          message:
            `Destination account does not exist. Creating it requires at least ` +
            `${MIN_STARTING_BALANCE} XLM.`,
          blocking: true,
        });
      } else {
        operationType = "createAccount";
        warnings.push({
          code: "DESTINATION_WILL_BE_CREATED",
          message:
            "Destination account does not exist yet. It will be created and funded with this amount.",
          blocking: false,
        });
      }
    } else {
      if (!stellarAsset.isNative() && stellarAsset.getIssuer() !== destinationPublicKey) {
        const trustline = findTrustline(destinationAccount, stellarAsset);
        if (!trustline) {
          warnings.push({
            code: "NO_TRUSTLINE",
            message: `Destination account does not trust ${assetLabel} and cannot receive it.`,
            blocking: true,
          });
        } else if (trustline.is_authorized === false) {
          warnings.push({
            code: "TRUSTLINE_NOT_AUTHORIZED",
            message: `Destination's ${assetLabel} trustline is not authorized by the issuer.`,
            blocking: true,
          });
        }
      }

      // Same SEP-29 rule `destinationRequiresMemo` / `sendPayment` enforce.
      if (accountRequiresMemo(destinationAccount) && !memo) {
        warnings.push({
          code: "MEMO_REQUIRED",
          message:
            "The destination requires a memo (SEP-29), e.g. an exchange deposit ID. " +
            "Sending without one may lose funds.",
          blocking: true,
        });
      }
    }

    return {
      warnings,
      blocking: warnings.some((w) => w.blocking),
      operationType,
      spendable,
    };
  }

  // ---------------------------------------------------------------------------
  //  Issue #62 – Paged payment iterator for CSV export
  // ---------------------------------------------------------------------------
  // Yields one Horizon page at a time (newest first) so the caller can stream
  // rows out and drop each page before fetching the next — memory stays
  // bounded by `pageSize` no matter how large the export is. Stops once the
  // page reaches records older than `from`; records newer than `to` are
  // skipped (Horizon's /payments has no date filter, only cursors).
  // ---------------------------------------------------------------------------

  async *iteratePaymentsForExport(
    publicKey: string,
    options: { from: Date; to: Date; pageSize?: number }
  ): AsyncGenerator<PaymentExportRecord[]> {
    const pageSize = options.pageSize ?? 200;
    const fromMs = options.from.getTime();
    const toMs = options.to.getTime();
    let cursor: string | undefined;

    for (;;) {
      let builder = this.server
        .payments()
        .forAccount(publicKey)
        .join("transactions")
        .limit(pageSize)
        .order("desc");
      if (cursor) builder = builder.cursor(cursor);

      const page = await builder.call();
      const records = page.records;
      if (records.length === 0) return;

      const batch: PaymentExportRecord[] = [];
      let reachedStart = false;
      for (const op of records) {
        const createdMs = Date.parse(op.created_at);
        if (createdMs > toMs) continue;
        if (createdMs < fromMs) {
          reachedStart = true;
          break;
        }
        let transaction: StellarSdk.Horizon.ServerApi.TransactionRecord | undefined;
        try {
          transaction = await op.transaction();
        } catch (err) {
          console.warn(`[stellar] failed to read joined transaction for operation ${op.id}: ${err}`);
        }
        batch.push({ op, transaction });
      }

      if (batch.length > 0) yield batch;
      if (reachedStart || records.length < pageSize) return;
      cursor = (records[records.length - 1] as unknown as { paging_token: string }).paging_token;
    }
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
  }): Promise<{ xdr: string; hash: string; operationType: SendOperationType }> {
    const { sourceSecretKey, destinationPublicKey, amount, asset, memo } = params;
    const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecretKey);
    const sourcePublicKey = sourceKeypair.publicKey();

    // #65 — an unfunded destination needs createAccount, not payment.
    const { operation, operationType } = await this.resolveSendOperation(
      destinationPublicKey,
      asset,
      amount
    );

    return this.accountLock.withLock(sourcePublicKey, async () => {
      const sourceAccount = await this.getAccount(sourcePublicKey);

      const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30);

      if (memo) builder.addMemo(StellarSdk.Memo.text(memo));

      const tx = builder.build();
      tx.sign(sourceKeypair);

      return {
        xdr: tx.toXDR(),
        hash: tx.hash().toString("hex"),
        operationType,
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
  if (!assetStr || assetStr === "XLM" || assetStr === "native") return StellarSdk.Asset.native();
  const [code, issuer] = assetStr.split(":");
  return new StellarSdk.Asset(code, issuer);
}

/** SEP-29: refuse to build or send to a memo-required destination without a memo. */
function assertMemoProvided(destinationPublicKey: string, requiresMemo: boolean, memo: string | undefined): void {
  if (requiresMemo && !memo) {
    throw new MemoRequiredError(
      `The destination account ${destinationPublicKey} requires a memo for transactions. ` +
        "Please provide a memo to avoid losing funds. (SEP-29)"
    );
  }
}

/** SEP-29: `config.memo_required` data entry set to "1" (base64 "MQ=="). */
export function accountRequiresMemo(account: StellarSdk.Horizon.AccountResponse): boolean {
  const data = account.data_attr as Record<string, string> | undefined;
  return data?.["config.memo_required"] === "MQ==";
}

/** The subset of a Horizon balance line the precheck reads. */
interface BalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  selling_liabilities?: string;
  sponsor?: string;
  is_authorized?: boolean;
}

function findTrustline(
  account: StellarSdk.Horizon.AccountResponse,
  asset: StellarSdk.Asset
): BalanceLine | undefined {
  return (account.balances as unknown as BalanceLine[]).find(
    (b) =>
      (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
      b.asset_code === asset.getCode() &&
      b.asset_issuer === asset.getIssuer()
  );
}

/**
 * What the account can actually send of `asset`, or undefined if it holds no
 * such balance. For XLM: balance - minimum reserve - selling liabilities -
 * one base fee. For issued assets: balance - selling liabilities. An issuer
 * sending its own asset has unlimited supply, so it returns its own cap.
 */
function spendableBalance(
  account: StellarSdk.Horizon.AccountResponse,
  asset: StellarSdk.Asset
): string | undefined {
  if (!asset.isNative() && asset.getIssuer() === account.account_id) {
    return "922337203685.4775807";
  }

  if (asset.isNative()) {
    const native = (account.balances as unknown as BalanceLine[]).find((b) => b.asset_type === "native");
    if (!native) return undefined;
    const extra = account as unknown as { num_sponsoring?: number; num_sponsored?: number };
    const entries =
      2n +
      BigInt(account.subentry_count) +
      BigInt(extra.num_sponsoring ?? 0) -
      BigInt(extra.num_sponsored ?? 0);
    const reserve = entries * toStroops(BASE_RESERVE);
    const liabilities = toStroops(native.selling_liabilities ?? "0");
    const available =
      toStroops(native.balance) - reserve - liabilities - BigInt(StellarSdk.BASE_FEE);
    return fromStroops(available > 0n ? available : 0n);
  }

  const line = findTrustline(account, asset);
  if (!line) return undefined;
  const available = toStroops(line.balance) - toStroops(line.selling_liabilities ?? "0");
  return fromStroops(available > 0n ? available : 0n);
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
