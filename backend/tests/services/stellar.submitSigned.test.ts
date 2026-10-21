import * as StellarSdk from "@stellar/stellar-sdk";
import { StellarService } from "../../src/services/stellar";
import {
  InvalidTransactionError,
  MemoRequiredError,
  NonRetryableHorizonError,
  PathExpiredError,
  SequenceConflictError,
  TransactionAlreadySubmittedError,
  TransactionExpiredError,
} from "../../src/services/stellarErrors";
import { feeBumped, horizonRejection, signedPayment } from "../helpers/signedTx";

const { Horizon } = StellarSdk;

function mockSubmit(response: unknown = { hash: "h", ledger: 321, successful: true }) {
  return jest.spyOn(Horizon.Server.prototype, "submitTransaction").mockResolvedValue(response as never);
}

function mockTransactionLookup(found: boolean) {
  return jest.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({
    transaction: () => ({
      call: async () => {
        if (found) return {};
        throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
      },
    }),
  } as never);
}

describe("StellarService.submitSigned (issue #2)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("submits a locally signed envelope as-is and returns hash, ledger and successful", async () => {
    const { xdr, tx } = signedPayment();
    const submit = mockSubmit({ hash: tx.hash().toString("hex"), ledger: 321, successful: true });

    const result = await new StellarService().submitSigned({ signedXdr: xdr });

    expect(result).toEqual({ hash: tx.hash().toString("hex"), ledger: 321, successful: true });
    const sent = submit.mock.calls[0][0] as StellarSdk.Transaction;
    // Never re-signed or rebuilt: the envelope is exactly what the client signed.
    expect(sent.toXDR()).toBe(xdr);
    expect(sent.signatures).toHaveLength(1);
  });

  it("accepts a fee-bump envelope", async () => {
    const inner = signedPayment();
    const bump = feeBumped(inner.tx, StellarSdk.Keypair.random());
    const submit = mockSubmit({ hash: bump.hash, ledger: 7, successful: true });

    const result = await new StellarService().submitSigned({ signedXdr: bump.xdr });

    expect(result).toMatchObject({ hash: bump.hash, successful: true });
    expect((submit.mock.calls[0][0] as StellarSdk.FeeBumpTransaction).toXDR()).toBe(bump.xdr);
  });

  it("rejects garbage that is not an XDR envelope", async () => {
    const submit = mockSubmit();

    const promise = new StellarService().submitSigned({ signedXdr: "not-xdr" });

    await expect(promise).rejects.toBeInstanceOf(InvalidTransactionError);
    await expect(promise).rejects.toMatchObject({
      code: "INVALID_TRANSACTION",
      status: 400,
      details: { reason: "MALFORMED_XDR" },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects an unsigned envelope before calling Horizon", async () => {
    const submit = mockSubmit();

    const promise = new StellarService().submitSigned({ signedXdr: signedPayment({ unsigned: true }).xdr });

    await expect(promise).rejects.toMatchObject({ code: "INVALID_TRANSACTION", details: { reason: "UNSIGNED" } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects an envelope signed for a different network passphrase", async () => {
    const submit = mockSubmit();
    const { xdr } = signedPayment({ networkPassphrase: StellarSdk.Networks.PUBLIC });

    const promise = new StellarService().submitSigned({ signedXdr: xdr });

    await expect(promise).rejects.toMatchObject({ code: "INVALID_TRANSACTION", details: { reason: "WRONG_NETWORK" } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a fee-bump whose inner transaction was signed for a different network", async () => {
    const inner = signedPayment({ networkPassphrase: StellarSdk.Networks.PUBLIC });
    const bump = feeBumped(inner.tx, StellarSdk.Keypair.random());
    const submit = mockSubmit();

    const promise = new StellarService().submitSigned({ signedXdr: bump.xdr });

    await expect(promise).rejects.toMatchObject({ details: { reason: "WRONG_NETWORK" } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns TX_EXPIRED without calling Horizon when timeBounds.maxTime has passed", async () => {
    const submit = mockSubmit();
    const { xdr } = signedPayment({ maxTime: Math.floor(Date.now() / 1000) - 60 });

    const promise = new StellarService().submitSigned({ signedXdr: xdr });

    await expect(promise).rejects.toBeInstanceOf(TransactionExpiredError);
    await expect(promise).rejects.toMatchObject({ code: "TX_EXPIRED", status: 400, retryable: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it("maps a Horizon tx_too_late to TX_EXPIRED", async () => {
    jest.spyOn(Horizon.Server.prototype, "submitTransaction").mockRejectedValue(horizonRejection({ transaction: "tx_too_late" }));

    const promise = new StellarService().submitSigned({ signedXdr: signedPayment().xdr });

    await expect(promise).rejects.toMatchObject({ code: "TX_EXPIRED" });
  });

  it("maps the SDK's own SEP-29 memo check to MEMO_REQUIRED instead of a 500", async () => {
    jest
      .spyOn(Horizon.Server.prototype, "submitTransaction")
      .mockRejectedValue(new StellarSdk.AccountRequiresMemoError("memo required", "GEXCHANGE", 0));

    const promise = new StellarService().submitSigned({ signedXdr: signedPayment().xdr });

    await expect(promise).rejects.toBeInstanceOf(MemoRequiredError);
    await expect(promise).rejects.toMatchObject({ code: "MEMO_REQUIRED", status: 400 });
  });

  it("returns a pending result with the hash when Horizon times out with a 504", async () => {
    const { xdr, hash } = signedPayment();
    jest
      .spyOn(Horizon.Server.prototype, "submitTransaction")
      .mockRejectedValue(Object.assign(new Error("Gateway Timeout"), { response: { status: 504 } }));

    const result = await new StellarService().submitSigned({ signedXdr: xdr });

    expect(result).toEqual({ hash, status: "pending" });
  });

  it("maps a tx_bad_seq for a hash that is already on the ledger to TX_ALREADY_SUBMITTED", async () => {
    const { xdr, hash } = signedPayment();
    jest.spyOn(Horizon.Server.prototype, "submitTransaction").mockRejectedValue(horizonRejection({ transaction: "tx_bad_seq" }));
    mockTransactionLookup(true);

    const promise = new StellarService().submitSigned({ signedXdr: xdr });

    await expect(promise).rejects.toBeInstanceOf(TransactionAlreadySubmittedError);
    await expect(promise).rejects.toMatchObject({ code: "TX_ALREADY_SUBMITTED", status: 409, details: { hash } });
  });

  it("reports a tx_bad_seq for an unknown hash as a sequence conflict, without retrying", async () => {
    const submit = jest
      .spyOn(Horizon.Server.prototype, "submitTransaction")
      .mockRejectedValue(horizonRejection({ transaction: "tx_bad_seq" }));
    mockTransactionLookup(false);

    const promise = new StellarService().submitSigned({ signedXdr: signedPayment().xdr });

    await expect(promise).rejects.toBeInstanceOf(SequenceConflictError);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each(["op_too_few_offers", "op_under_dest_min", "op_over_source_max"])(
    "maps a path payment rejection with %s to PATH_EXPIRED so the UI can re-quote",
    async (operationCode) => {
      jest
        .spyOn(Horizon.Server.prototype, "submitTransaction")
        .mockRejectedValue(horizonRejection({ transaction: "tx_failed", operations: [operationCode] }));

      const promise = new StellarService().submitSigned({ signedXdr: signedPayment().xdr });

      await expect(promise).rejects.toBeInstanceOf(PathExpiredError);
      await expect(promise).rejects.toMatchObject({ code: "PATH_EXPIRED", status: 409, retryable: true });
    }
  );

  it("passes other Horizon result codes through the existing HORIZON_REJECTED mapping", async () => {
    jest
      .spyOn(Horizon.Server.prototype, "submitTransaction")
      .mockRejectedValue(horizonRejection({ transaction: "tx_failed", operations: ["op_underfunded"] }));

    const promise = new StellarService().submitSigned({ signedXdr: signedPayment().xdr });

    await expect(promise).rejects.toBeInstanceOf(NonRetryableHorizonError);
    await expect(promise).rejects.toMatchObject({
      code: "HORIZON_REJECTED",
      details: { horizonResultCodes: { transaction: "tx_failed", operations: ["op_underfunded"] } },
    });
  });
});
