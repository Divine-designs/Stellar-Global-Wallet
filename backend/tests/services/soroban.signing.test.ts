import * as StellarSdk from "@stellar/stellar-sdk";
import { SorobanService } from "../../src/services/soroban";
import {
  SorobanRebuildRequiredError,
  SorobanSimulationError,
  SorobanTransactionError,
  SorobanUnavailableError,
} from "../../src/services/sorobanErrors";
import { SourceAccountNotFoundError, TransactionExpiredError } from "../../src/services/stellarErrors";
import { signedPayment } from "../helpers/signedTx";

const { rpc, xdr } = StellarSdk;

const CONTRACT_ID = "CBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K";
const PASSPHRASE = process.env.SOROBAN_NETWORK_PASSPHRASE as string;

function authEntry() {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new StellarSdk.Address(CONTRACT_ID).toScAddress(),
          functionName: "record_spend",
          args: [],
        })
      ),
      subInvocations: [],
    }),
  });
}

function successSimulation(auth: StellarSdk.xdr.SorobanAuthorizationEntry[] = []) {
  return {
    id: "1",
    latestLedger: 4242,
    events: [],
    _parsed: true,
    // Real simulations set the data's resourceFee to minResourceFee; assembly folds it into the tx fee.
    transactionData: new StellarSdk.SorobanDataBuilder().setResourceFee(12345),
    minResourceFee: "12345",
    cost: { cpuInsns: "0", memBytes: "0" },
    result: { auth, retval: xdr.ScVal.scvVoid() },
  } as unknown as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
}

function errorSimulation(error: string) {
  return { id: "1", latestLedger: 4242, events: [], _parsed: true, error } as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
}

describe("SorobanService.prepareInvocation (issue #4)", () => {
  const user = StellarSdk.Keypair.random().publicKey();
  const params = {
    contractId: CONTRACT_ID,
    method: "record_spend",
    sourcePublicKey: user,
    args: [
      StellarSdk.nativeToScVal(user, { type: "address" }),
      StellarSdk.nativeToScVal("XLM", { type: "string" }),
      StellarSdk.nativeToScVal(1000n, { type: "i128" }),
    ],
  };

  afterEach(() => jest.restoreAllMocks());

  it("returns the simulated, assembled transaction unsigned with the resource fee and ledger", async () => {
    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new StellarSdk.Account(user, "700"));
    const sim = jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(successSimulation());
    const send = jest.spyOn(rpc.Server.prototype, "sendTransaction");

    const prepared = await new SorobanService().prepareInvocation(params);

    expect(sim).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    const tx = StellarSdk.TransactionBuilder.fromXDR(prepared.xdr, PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.signatures).toHaveLength(0);
    expect(tx.source).toBe(user);
    expect(tx.sequence).toBe("701");
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
    // The assembled fee is the inclusion fee plus the simulated resource fee.
    expect(prepared.fee).toBe(String(Number(StellarSdk.BASE_FEE) + 12345));
    expect(prepared).toMatchObject({
      networkPassphrase: PASSPHRASE,
      minResourceFee: "12345",
      latestLedger: 4242,
      authEntries: [],
      sequence: "701",
    });
    expect(Number(prepared.timeBounds.maxTime)).toBeGreaterThan(Math.floor(Date.now() / 1000) + 170);
    expect(prepared.expiresAt).toEqual(expect.any(String));
  });

  it("returns the authorization entries from simulation as base64 XDR", async () => {
    const entry = authEntry();
    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new StellarSdk.Account(user, "1"));
    jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(successSimulation([entry]));

    const prepared = await new SorobanService().prepareInvocation(params);

    expect(prepared.authEntries).toEqual([entry.toXDR("base64")]);
  });

  it("throws SorobanSimulationError with the raw contract error and returns no XDR when simulation fails", async () => {
    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new StellarSdk.Account(user, "1"));
    jest
      .spyOn(rpc.Server.prototype, "simulateTransaction")
      .mockResolvedValue(errorSimulation("HostError: Error(Contract, #1007)"));

    const promise = new SorobanService().prepareInvocation(params);

    await expect(promise).rejects.toBeInstanceOf(SorobanSimulationError);
    await expect(promise).rejects.toMatchObject({ raw: "HostError: Error(Contract, #1007)", status: 422 });
  });

  it("throws SOURCE_ACCOUNT_NOT_FOUND (404) for an account that does not exist", async () => {
    jest.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(new Error(`Account not found: ${user}`));
    const sim = jest.spyOn(rpc.Server.prototype, "simulateTransaction");

    const promise = new SorobanService().prepareInvocation(params);

    await expect(promise).rejects.toBeInstanceOf(SourceAccountNotFoundError);
    await expect(promise).rejects.toMatchObject({ code: "SOURCE_ACCOUNT_NOT_FOUND", status: 404 });
    expect(sim).not.toHaveBeenCalled();
  });

  it.each([
    ["loading the account", () => jest.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(new Error("ECONNREFUSED"))],
    [
      "simulating",
      () => {
        jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new StellarSdk.Account(user, "1"));
        return jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockRejectedValue(new Error("socket hang up"));
      },
    ],
  ])("returns 503 SOROBAN_UNAVAILABLE with retryable true when RPC fails while %s", async (_label, arrange) => {
    arrange();

    const promise = new SorobanService().prepareInvocation(params);

    await expect(promise).rejects.toBeInstanceOf(SorobanUnavailableError);
    await expect(promise).rejects.toMatchObject({ code: "SOROBAN_UNAVAILABLE", status: 503, retryable: true });
  });
});

describe("SorobanService.submitSigned (issue #4)", () => {
  const sendResponse = (status: string, extra: Record<string, unknown> = {}) =>
    ({ status, hash: "f".repeat(64), latestLedger: 1, latestLedgerCloseTime: 0, ...extra }) as StellarSdk.rpc.Api.SendTransactionResponse;

  const finalResponse = (status: StellarSdk.rpc.Api.GetTransactionStatus, extra: Record<string, unknown> = {}) =>
    ({ status, latestLedger: 2, latestLedgerCloseTime: 0, oldestLedger: 1, oldestLedgerCloseTime: 0, ledger: 99, ...extra }) as
      StellarSdk.rpc.Api.GetTransactionResponse;

  function failedSend(resultCode: "txSorobanInvalid" | "txTooLate" | "txBadSeq" | "txInsufficientBalance") {
    const result = new xdr.TransactionResult({
      feeCharged: new xdr.Int64(0),
      result: xdr.TransactionResultResult[resultCode](),
      ext: new xdr.TransactionResultExt(0),
    });
    return sendResponse("ERROR", { errorResult: result });
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("sends the signed transaction exactly as signed, polls, and returns the final result", async () => {
    const { xdr: signedXdr } = signedPayment();
    const send = jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(sendResponse("PENDING"));
    jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(finalResponse(rpc.Api.GetTransactionStatus.SUCCESS));

    const result = await new SorobanService().submitSigned({ signedXdr });

    expect(result).toEqual({ hash: "f".repeat(64), ledger: 99, successful: true });
    expect((send.mock.calls[0][0] as StellarSdk.Transaction).toXDR()).toBe(signedXdr);
  });

  it("polls getTransaction until the status is final", async () => {
    jest.useFakeTimers();
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(sendResponse("PENDING"));
    const get = jest
      .spyOn(rpc.Server.prototype, "getTransaction")
      .mockResolvedValueOnce(finalResponse(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(finalResponse(rpc.Api.GetTransactionStatus.NOT_FOUND))
      .mockResolvedValueOnce(finalResponse(rpc.Api.GetTransactionStatus.SUCCESS));

    const promise = new SorobanService().submitSigned({ signedXdr: signedPayment().xdr });
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(promise).resolves.toEqual({ hash: "f".repeat(64), ledger: 99, successful: true });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("waits for a DUPLICATE submission's result instead of failing", async () => {
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(sendResponse("DUPLICATE"));
    jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(finalResponse(rpc.Api.GetTransactionStatus.SUCCESS));

    await expect(new SorobanService().submitSigned({ signedXdr: signedPayment().xdr })).resolves.toMatchObject({
      successful: true,
    });
  });

  it("returns the hash as pending when the network has not decided within 30 seconds", async () => {
    jest.useFakeTimers();
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(sendResponse("PENDING"));
    jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(finalResponse(rpc.Api.GetTransactionStatus.NOT_FOUND));

    const promise = new SorobanService().submitSigned({ signedXdr: signedPayment({ maxTime: Math.floor(Date.now() / 1000) + 600 }).xdr });
    await jest.advanceTimersByTimeAsync(35_000);

    await expect(promise).resolves.toEqual({ hash: "f".repeat(64), status: "pending" });
  });

  it("throws SorobanTransactionError with the hash when the transaction fails on-chain", async () => {
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(sendResponse("PENDING"));
    jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(finalResponse(rpc.Api.GetTransactionStatus.FAILED));

    const promise = new SorobanService().submitSigned({ signedXdr: signedPayment().xdr });

    await expect(promise).rejects.toBeInstanceOf(SorobanTransactionError);
    await expect(promise).rejects.toMatchObject({ code: "SOROBAN_TX_FAILED", details: { hash: "f".repeat(64) } });
  });

  it.each(["txSorobanInvalid", "txBadSeq"] as const)(
    "tells the client to rebuild (retryable 409) when the network rejects with %s",
    async (resultCode) => {
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(failedSend(resultCode));
      const poll = jest.spyOn(rpc.Server.prototype, "getTransaction");

      const promise = new SorobanService().submitSigned({ signedXdr: signedPayment().xdr });

      await expect(promise).rejects.toBeInstanceOf(SorobanRebuildRequiredError);
      await expect(promise).rejects.toMatchObject({
        code: "SOROBAN_REBUILD_REQUIRED",
        status: 409,
        retryable: true,
        details: { resultCode },
      });
      expect(poll).not.toHaveBeenCalled();
    }
  );

  it("maps txTooLate to TX_EXPIRED", async () => {
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(failedSend("txTooLate"));

    await expect(new SorobanService().submitSigned({ signedXdr: signedPayment().xdr })).rejects.toBeInstanceOf(
      TransactionExpiredError
    );
  });

  it("rejects other pre-ledger failures like invoke does", async () => {
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(failedSend("txInsufficientBalance"));

    await expect(new SorobanService().submitSigned({ signedXdr: signedPayment().xdr })).rejects.toBeInstanceOf(
      SorobanSimulationError
    );
  });

  it("returns 503 SOROBAN_UNAVAILABLE when RPC is busy or down", async () => {
    const service = new SorobanService();
    const busy = jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(sendResponse("TRY_AGAIN_LATER"));
    await expect(service.submitSigned({ signedXdr: signedPayment().xdr })).rejects.toMatchObject({
      code: "SOROBAN_UNAVAILABLE",
      status: 503,
      retryable: true,
    });

    busy.mockRejectedValue(new Error("ECONNRESET"));
    await expect(service.submitSigned({ signedXdr: signedPayment().xdr })).rejects.toBeInstanceOf(SorobanUnavailableError);
  });

  it("rejects unsigned, wrong-network and expired envelopes without calling RPC", async () => {
    const send = jest.spyOn(rpc.Server.prototype, "sendTransaction");
    const service = new SorobanService();

    await expect(service.submitSigned({ signedXdr: "garbage" })).rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
    await expect(service.submitSigned({ signedXdr: signedPayment({ unsigned: true }).xdr })).rejects.toMatchObject({
      details: { reason: "UNSIGNED" },
    });
    await expect(
      service.submitSigned({ signedXdr: signedPayment({ networkPassphrase: StellarSdk.Networks.PUBLIC }).xdr })
    ).rejects.toMatchObject({ details: { reason: "WRONG_NETWORK" } });
    await expect(
      service.submitSigned({ signedXdr: signedPayment({ maxTime: Math.floor(Date.now() / 1000) - 5 }).xdr })
    ).rejects.toMatchObject({ code: "TX_EXPIRED" });
    expect(send).not.toHaveBeenCalled();
  });
});
