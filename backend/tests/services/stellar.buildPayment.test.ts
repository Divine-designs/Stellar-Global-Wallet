import * as StellarSdk from "@stellar/stellar-sdk";
import { StellarService } from "../../src/services/stellar";
import { MemoRequiredError, SourceAccountNotFoundError } from "../../src/services/stellarErrors";

const { Horizon } = StellarSdk;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE as string;

function fakeAccount(publicKey: string, sequence = "100", extra: Record<string, unknown> = {}) {
  return Object.assign(new StellarSdk.Account(publicKey, sequence), extra) as unknown as StellarSdk.Horizon.AccountResponse;
}

function notFound() {
  return Object.assign(new Error("Not Found"), { response: { status: 404 } });
}

/** Resolves accounts from `accounts`; anything else is a Horizon 404. */
function mockAccounts(accounts: Record<string, StellarSdk.Horizon.AccountResponse>) {
  return jest.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => {
    if (accounts[id]) return accounts[id];
    throw notFound();
  });
}

function decode(xdr: string) {
  return StellarSdk.TransactionBuilder.fromXDR(xdr, PASSPHRASE) as StellarSdk.Transaction;
}

describe("StellarService.buildPayment (issue #1)", () => {
  const source = StellarSdk.Keypair.random().publicKey();
  const destination = StellarSdk.Keypair.random().publicKey();

  beforeEach(() => {
    jest.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(200);
  });
  afterEach(() => jest.restoreAllMocks());

  it("returns an unsigned XDR with one payment operation and the documented fields", async () => {
    mockAccounts({ [source]: fakeAccount(source, "100"), [destination]: fakeAccount(destination) });
    const submitSpy = jest.spyOn(Horizon.Server.prototype, "submitTransaction");

    const built = await new StellarService().buildPayment({
      sourcePublicKey: source,
      destinationPublicKey: destination,
      amount: "12.5",
    });

    const tx = decode(built.xdr);
    expect(tx.signatures).toHaveLength(0);
    expect(tx.source).toBe(source);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({
      type: "payment",
      destination,
      amount: "12.5000000",
    });
    expect((tx.operations[0] as StellarSdk.Operation.Payment).asset.isNative()).toBe(true);

    expect(built.networkPassphrase).toBe(PASSPHRASE);
    expect(built.operationType).toBe("payment");
    expect(built.fee).toBe("200");
    expect(built.sequence).toBe("101");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("sets a 180 second expiry and reports it as timeBounds and expiresAt", async () => {
    mockAccounts({ [source]: fakeAccount(source), [destination]: fakeAccount(destination) });
    const before = Math.floor(Date.now() / 1000);

    const built = await new StellarService().buildPayment({
      sourcePublicKey: source,
      destinationPublicKey: destination,
      amount: "1",
    });

    const maxTime = Number(built.timeBounds.maxTime);
    expect(maxTime).toBeGreaterThanOrEqual(before + 180);
    expect(maxTime).toBeLessThanOrEqual(before + 185);
    expect(built.timeBounds.minTime).toBe("0");
    expect(built.expiresAt).toBe(new Date(maxTime * 1000).toISOString());
    expect(decode(built.xdr).timeBounds?.maxTime).toBe(built.timeBounds.maxTime);
  });

  it("builds an issued-asset payment with a text memo", async () => {
    const issuer = StellarSdk.Keypair.random().publicKey();
    mockAccounts({ [source]: fakeAccount(source), [destination]: fakeAccount(destination) });

    const built = await new StellarService().buildPayment({
      sourcePublicKey: source,
      destinationPublicKey: destination,
      amount: "3",
      asset: `USDC:${issuer}`,
      memo: "invoice 42",
    });

    const tx = decode(built.xdr);
    const op = tx.operations[0] as StellarSdk.Operation.Payment;
    expect(op.asset.getCode()).toBe("USDC");
    expect(op.asset.getIssuer()).toBe(issuer);
    expect(tx.memo.value?.toString()).toBe("invoice 42");
  });

  it("treats XLM and native as the native asset", async () => {
    mockAccounts({ [source]: fakeAccount(source), [destination]: fakeAccount(destination) });
    const stellar = new StellarService();

    for (const asset of ["XLM", "native"]) {
      const built = await stellar.buildPayment({
        sourcePublicKey: source,
        destinationPublicKey: destination,
        amount: "1",
        asset,
      });
      expect((decode(built.xdr).operations[0] as StellarSdk.Operation.Payment).asset.isNative()).toBe(true);
    }
  });

  it("returns the same sequence for two builds in a row because nothing is submitted", async () => {
    mockAccounts({ [source]: fakeAccount(source, "500"), [destination]: fakeAccount(destination) });
    const stellar = new StellarService();
    const params = { sourcePublicKey: source, destinationPublicKey: destination, amount: "1" };

    const first = await stellar.buildPayment(params);
    const second = await stellar.buildPayment(params);

    expect(first.sequence).toBe("501");
    expect(second.sequence).toBe("501");
  });

  it("falls back to the protocol base fee when Horizon fee stats are unavailable", async () => {
    mockAccounts({ [source]: fakeAccount(source), [destination]: fakeAccount(destination) });
    jest.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockRejectedValue(new Error("horizon down"));

    const built = await new StellarService().buildPayment({
      sourcePublicKey: source,
      destinationPublicKey: destination,
      amount: "1",
    });

    expect(built.fee).toBe(StellarSdk.BASE_FEE);
  });

  describe("SEP-29 memo requirement", () => {
    const memoRequired = { data_attr: { "config.memo_required": "MQ==" } };

    it("rejects a memo-required destination with no memo, using the same error as /send", async () => {
      mockAccounts({
        [source]: fakeAccount(source),
        [destination]: fakeAccount(destination, "1", memoRequired),
      });

      const promise = new StellarService().buildPayment({
        sourcePublicKey: source,
        destinationPublicKey: destination,
        amount: "1",
      });

      await expect(promise).rejects.toBeInstanceOf(MemoRequiredError);
      await expect(promise).rejects.toMatchObject({ code: "MEMO_REQUIRED", status: 400 });
    });

    it("builds when the memo is supplied", async () => {
      mockAccounts({
        [source]: fakeAccount(source),
        [destination]: fakeAccount(destination, "1", memoRequired),
      });

      const built = await new StellarService().buildPayment({
        sourcePublicKey: source,
        destinationPublicKey: destination,
        amount: "1",
        memo: "deposit-77",
      });

      expect(decode(built.xdr).memo.value?.toString()).toBe("deposit-77");
    });
  });

  it("throws SOURCE_ACCOUNT_NOT_FOUND (404) when the source account is unfunded", async () => {
    mockAccounts({ [destination]: fakeAccount(destination) });

    const promise = new StellarService().buildPayment({
      sourcePublicKey: source,
      destinationPublicKey: destination,
      amount: "1",
    });

    await expect(promise).rejects.toBeInstanceOf(SourceAccountNotFoundError);
    await expect(promise).rejects.toMatchObject({ code: "SOURCE_ACCOUNT_NOT_FOUND", status: 404 });
  });

  it("encodes a muxed destination in the operation and runs lookups against its base account", async () => {
    const muxed = new StellarSdk.MuxedAccount(new StellarSdk.Account(destination, "0"), "9007199254740993").accountId();
    const loadSpy = mockAccounts({ [source]: fakeAccount(source), [destination]: fakeAccount(destination) });

    const built = await new StellarService().buildPayment({
      sourcePublicKey: source,
      destinationPublicKey: muxed,
      amount: "2",
    });

    expect((decode(built.xdr).operations[0] as StellarSdk.Operation.Payment).destination).toBe(muxed);
    const loaded = loadSpy.mock.calls.map(([id]) => id);
    expect(loaded).toContain(destination);
    expect(loaded).not.toContain(muxed);
  });

  it("builds createAccount for an unfunded destination that receives at least the minimum balance", async () => {
    mockAccounts({ [source]: fakeAccount(source) });

    const built = await new StellarService().buildPayment({
      sourcePublicKey: source,
      destinationPublicKey: destination,
      amount: "5",
    });

    expect(built.operationType).toBe("createAccount");
    expect(decode(built.xdr).operations[0]).toMatchObject({
      type: "createAccount",
      destination,
      startingBalance: "5.0000000",
    });
  });
});
