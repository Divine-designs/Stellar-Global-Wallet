import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createContractRouter } from "../../src/routes/contract";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";
import { SorobanService } from "../../src/services/soroban";
import { SorobanContractError, SorobanUnavailableError } from "../../src/services/sorobanErrors";
import { appWithRouter, authHeader } from "../helpers/routerApp";

const { rpc } = StellarSdk;
const PASSPHRASE = process.env.SOROBAN_NETWORK_PASSPHRASE as string;
const user = StellarSdk.Keypair.random().publicKey();

function appWith(globeWallet: Partial<GlobeWalletContract>) {
  return appWithRouter("/api/v1/contract", createContractRouter(globeWallet as GlobeWalletContract));
}

const prepared = {
  xdr: "AAAA",
  networkPassphrase: PASSPHRASE,
  fee: "12445",
  sequence: "5",
  timeBounds: { minTime: "0", maxTime: "9999999999" },
  expiresAt: "2286-11-20T17:46:39.000Z",
  minResourceFee: "12345",
  authEntries: [],
  latestLedger: 10,
};

describe("POST /api/v1/contract/wallet/spend/build (issue #4)", () => {
  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  const body = (overrides: Record<string, unknown> = {}) => ({
    userPublicKey: user,
    assetCode: "XLM",
    amount: "1000",
    ...overrides,
  });

  it("rejects an unauthenticated request", async () => {
    const app = appWith({ buildRecordSpend: jest.fn() });
    await request(app).post("/api/v1/contract/wallet/spend/build").send(body()).expect(401);
  });

  it("returns the prepared XDR with fee, auth entries and ledger, without any secret key", async () => {
    const buildRecordSpend = jest.fn().mockResolvedValue(prepared);
    const app = appWith({ buildRecordSpend });

    const res = await request(app)
      .post("/api/v1/contract/wallet/spend/build")
      .set(authHeader())
      .send(body())
      .expect(200);

    expect(res.body).toEqual(prepared);
    expect(buildRecordSpend).toHaveBeenCalledWith({ userPublicKey: user, assetCode: "XLM", amount: "1000" });
  });

  it("rejects userSecretKey instead of accepting or ignoring it, without echoing it", async () => {
    const buildRecordSpend = jest.fn();
    const secret = StellarSdk.Keypair.random().secret();

    const res = await request(appWith({ buildRecordSpend }))
      .post("/api/v1/contract/wallet/spend/build")
      .set(authHeader())
      .send(body({ userSecretKey: secret }))
      .expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: "userSecretKey" }));
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(buildRecordSpend).not.toHaveBeenCalled();
  });

  it.each([
    ["userPublicKey", { userPublicKey: "G" + "A".repeat(55) }],
    ["userPublicKey", { userPublicKey: undefined }],
    ["assetCode", { assetCode: "" }],
    ["assetCode", { assetCode: "WAYTOOLONGASSETCODE" }],
    ["assetCode", { assetCode: "X-LM" }],
    ["amount", { amount: "1.5" }],
    ["amount", { amount: "0" }],
    ["amount", { amount: "-5" }],
    ["amount", { amount: "abc" }],
    ["amount", { amount: 1000 }],
    ["amount", { amount: "170141183460469231731687303715884105728" }], // i128 max + 1
  ])("rejects an invalid %s", async (path, override) => {
    const buildRecordSpend = jest.fn();

    const res = await request(appWith({ buildRecordSpend }))
      .post("/api/v1/contract/wallet/spend/build")
      .set(authHeader())
      .send(body(override))
      .expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path }));
    expect(buildRecordSpend).not.toHaveBeenCalled();
  });

  it("returns the mapped contract error code when simulation rejects the spend", async () => {
    const buildRecordSpend = jest
      .fn()
      .mockRejectedValue(
        new SorobanContractError("SpendLimitExceeded (contract error #1007): over limit", "SPEND_LIMIT_EXCEEDED", 1007)
      );

    const res = await request(appWith({ buildRecordSpend }))
      .post("/api/v1/contract/wallet/spend/build")
      .set(authHeader())
      .send(body())
      .expect(422);

    expect(res.body.error).toMatchObject({ code: "SPEND_LIMIT_EXCEEDED", details: { contractErrorCode: 1007 } });
  });

  it("returns 503 with retryable true when Soroban RPC is unavailable", async () => {
    const buildRecordSpend = jest.fn().mockRejectedValue(new SorobanUnavailableError());

    const res = await request(appWith({ buildRecordSpend }))
      .post("/api/v1/contract/wallet/spend/build")
      .set(authHeader())
      .send(body())
      .expect(503);

    expect(res.body.error).toMatchObject({ code: "SOROBAN_UNAVAILABLE", retryable: true });
  });

  it("builds a decodable, unsigned invocation through the real service when only RPC is mocked", async () => {
    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new StellarSdk.Account(user, "41"));
    jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      id: "1",
      latestLedger: 77,
      events: [],
      _parsed: true,
      transactionData: new StellarSdk.SorobanDataBuilder(),
      minResourceFee: "500",
      cost: { cpuInsns: "0", memBytes: "0" },
      result: { auth: [], retval: StellarSdk.xdr.ScVal.scvVoid() },
    } as unknown as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse);
    const app = appWith(new GlobeWalletContract(new SorobanService()));

    const res = await request(app)
      .post("/api/v1/contract/wallet/spend/build")
      .set(authHeader())
      .send(body({ amount: "9007199254740993" }))
      .expect(200);

    expect(res.body).toMatchObject({ minResourceFee: "500", latestLedger: 77, authEntries: [], sequence: "42" });
    const tx = StellarSdk.TransactionBuilder.fromXDR(res.body.xdr, PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.signatures).toHaveLength(0);
    expect(tx.source).toBe(user);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });
});

describe("POST /api/v1/contract/wallet/submit (issue #4)", () => {
  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("rejects an unauthenticated request", async () => {
    await request(appWith({ submitSigned: jest.fn() })).post("/api/v1/contract/wallet/submit").send({ signedXdr: "AAAA" }).expect(401);
  });

  it("returns the final result once the transaction is settled", async () => {
    const submitSigned = jest.fn().mockResolvedValue({ hash: "abc", ledger: 12, successful: true });

    const res = await request(appWith({ submitSigned }))
      .post("/api/v1/contract/wallet/submit")
      .set(authHeader())
      .send({ signedXdr: "AAAA" })
      .expect(200);

    expect(res.body).toEqual({ hash: "abc", ledger: 12, successful: true });
    expect(submitSigned).toHaveBeenCalledWith("AAAA");
  });

  it("returns 202 with the hash when the network has not settled yet", async () => {
    const submitSigned = jest.fn().mockResolvedValue({ hash: "abc", status: "pending" });

    const res = await request(appWith({ submitSigned }))
      .post("/api/v1/contract/wallet/submit")
      .set(authHeader())
      .send({ signedXdr: "AAAA" })
      .expect(202);

    expect(res.body).toEqual({ hash: "abc", status: "pending" });
  });

  it("rejects a missing signedXdr and any secret-key field", async () => {
    const submitSigned = jest.fn();
    const app = appWith({ submitSigned });

    const missing = await request(app).post("/api/v1/contract/wallet/submit").set(authHeader()).send({}).expect(400);
    expect(missing.body.error.details).toContainEqual(expect.objectContaining({ path: "signedXdr" }));

    const secret = await request(app)
      .post("/api/v1/contract/wallet/submit")
      .set(authHeader())
      .send({ signedXdr: "AAAA", userSecretKey: StellarSdk.Keypair.random().secret() })
      .expect(400);
    expect(secret.body.error.details).toContainEqual(expect.objectContaining({ path: "userSecretKey" }));
    expect(submitSigned).not.toHaveBeenCalled();
  });

  it("surfaces a rebuild-required error from the service as a retryable 409", async () => {
    const { SorobanRebuildRequiredError } = await import("../../src/services/sorobanErrors");
    const submitSigned = jest.fn().mockRejectedValue(new SorobanRebuildRequiredError("stale", "txSorobanInvalid"));

    const res = await request(appWith({ submitSigned }))
      .post("/api/v1/contract/wallet/submit")
      .set(authHeader())
      .send({ signedXdr: "AAAA" })
      .expect(409);

    expect(res.body.error).toMatchObject({ code: "SOROBAN_REBUILD_REQUIRED", retryable: true });
  });
});
