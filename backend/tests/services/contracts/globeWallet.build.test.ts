import * as StellarSdk from "@stellar/stellar-sdk";
import { SorobanService, PreparedInvocation } from "../../../src/services/soroban";
import { GlobeWalletContract } from "../../../src/services/contracts/globeWallet";
import {
  SorobanContractError,
  SorobanSimulationError,
  SorobanTransactionError,
} from "../../../src/services/sorobanErrors";

const prepared: PreparedInvocation = {
  xdr: "AAAA",
  networkPassphrase: "Test SDF Network ; September 2015",
  fee: "12445",
  sequence: "5",
  timeBounds: { minTime: "0", maxTime: "1" },
  expiresAt: null,
  minResourceFee: "12345",
  authEntries: [],
  latestLedger: 10,
};

describe("GlobeWalletContract.buildRecordSpend (issue #4)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("prepares record_spend for the user's public key, with no secret key anywhere", async () => {
    const prepare = jest.spyOn(SorobanService.prototype, "prepareInvocation").mockResolvedValue(prepared);
    const invoke = jest.spyOn(SorobanService.prototype, "invoke");
    const user = StellarSdk.Keypair.random().publicKey();

    const result = await new GlobeWalletContract(new SorobanService()).buildRecordSpend({
      userPublicKey: user,
      assetCode: "XLM",
      amount: "500000",
    });

    expect(result).toBe(prepared);
    expect(prepare).toHaveBeenCalledWith({
      contractId: expect.any(String),
      method: "record_spend",
      sourcePublicKey: user,
      args: [
        StellarSdk.nativeToScVal(user, { type: "address" }),
        StellarSdk.nativeToScVal("XLM", { type: "string" }),
        StellarSdk.nativeToScVal(500000n, { type: "i128" }),
      ],
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("converts a decimal-string amount past 2^53 to an i128 without losing a stroop", async () => {
    const prepare = jest.spyOn(SorobanService.prototype, "prepareInvocation").mockResolvedValue(prepared);
    const amount = "170141183460469231731687303715884105727"; // i128 max

    await new GlobeWalletContract(new SorobanService()).buildRecordSpend({
      userPublicKey: StellarSdk.Keypair.random().publicKey(),
      assetCode: "USDC",
      amount,
    });

    const amountArg = prepare.mock.calls[0][0].args[2];
    expect(StellarSdk.scValToNative(amountArg)).toBe(BigInt(amount));
  });

  it("maps a spend-limit simulation failure to SPEND_LIMIT_EXCEEDED", async () => {
    jest
      .spyOn(SorobanService.prototype, "prepareInvocation")
      .mockRejectedValue(
        new SorobanSimulationError("Simulation failed: HostError: Error(Contract, #1007)", "HostError: Error(Contract, #1007)")
      );

    const promise = new GlobeWalletContract(new SorobanService()).buildRecordSpend({
      userPublicKey: StellarSdk.Keypair.random().publicKey(),
      assetCode: "XLM",
      amount: "999999999",
    });

    await expect(promise).rejects.toBeInstanceOf(SorobanContractError);
    await expect(promise).rejects.toMatchObject({
      code: "SPEND_LIMIT_EXCEEDED",
      status: 422,
      retryable: false,
      details: { contractErrorCode: 1007 },
      message: expect.stringMatching(/SpendLimitExceeded \(contract error #1007\)/),
    });
  });

  it("leaves a simulation failure without a known contract code as a plain simulation error", async () => {
    jest
      .spyOn(SorobanService.prototype, "prepareInvocation")
      .mockRejectedValue(new SorobanSimulationError("Simulation failed: HostError: out of budget", "HostError: out of budget"));

    const promise = new GlobeWalletContract(new SorobanService()).buildRecordSpend({
      userPublicKey: StellarSdk.Keypair.random().publicKey(),
      assetCode: "XLM",
      amount: "1",
    });

    await expect(promise).rejects.toBeInstanceOf(SorobanSimulationError);
    await expect(promise).rejects.toMatchObject({ code: "SOROBAN_SIMULATION_FAILED" });
  });
});

describe("GlobeWalletContract.submitSigned (issue #4)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("delegates to the Soroban service", async () => {
    const submit = jest
      .spyOn(SorobanService.prototype, "submitSigned")
      .mockResolvedValue({ hash: "abc", ledger: 7, successful: true });

    const result = await new GlobeWalletContract(new SorobanService()).submitSigned("SIGNED");

    expect(result).toEqual({ hash: "abc", ledger: 7, successful: true });
    expect(submit).toHaveBeenCalledWith({ signedXdr: "SIGNED" });
  });

  it("translates an on-chain contract error into a readable message", async () => {
    jest
      .spyOn(SorobanService.prototype, "submitSigned")
      .mockRejectedValue(new SorobanTransactionError("failed: Error(Contract, #1007)", "abc"));

    await expect(new GlobeWalletContract(new SorobanService()).submitSigned("SIGNED")).rejects.toThrow(
      /SpendLimitExceeded \(contract error #1007\)/
    );
  });
});
