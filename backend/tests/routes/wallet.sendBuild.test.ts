import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createClientSigningRouter } from "../../src/routes/clientSigning";
import { StellarService } from "../../src/services/stellar";
import { appWithRouter, authHeader } from "../helpers/routerApp";

const { Horizon } = StellarSdk;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE as string;

const source = StellarSdk.Keypair.random().publicKey();
const destination = StellarSdk.Keypair.random().publicKey();
const secret = StellarSdk.Keypair.random().secret();

function fakeAccount(publicKey: string, sequence = "100") {
  return new StellarSdk.Account(publicKey, sequence) as unknown as StellarSdk.Horizon.AccountResponse;
}

function mockHorizon(accounts: string[]) {
  jest.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(100);
  jest.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => {
    if (accounts.includes(id)) return fakeAccount(id);
    throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
  });
}

describe("POST /api/v1/wallet/send/build (issue #1)", () => {
  const app = appWithRouter("/api/v1/wallet", createClientSigningRouter(new StellarService()));
  const post = () => request(app).post("/api/v1/wallet/send/build").set(authHeader());

  // errorHandler logs every error it maps; keep the test output readable.
  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("rejects an unauthenticated request", async () => {
    await request(app)
      .post("/api/v1/wallet/send/build")
      .send({ sourcePublicKey: source, destinationPublicKey: destination, amount: "1" })
      .expect(401);
  });

  it("returns the unsigned XDR and every documented field", async () => {
    mockHorizon([source, destination]);

    const res = await post()
      .send({ sourcePublicKey: source, destinationPublicKey: destination, amount: "10.25", memo: "rent" })
      .expect(200);

    expect(res.body).toEqual({
      xdr: expect.any(String),
      networkPassphrase: PASSPHRASE,
      fee: "100",
      sequence: "101",
      timeBounds: { minTime: "0", maxTime: expect.any(String) },
      expiresAt: expect.any(String),
      operationType: "payment",
    });

    const tx = StellarSdk.TransactionBuilder.fromXDR(res.body.xdr, PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations[0]).toMatchObject({ type: "payment", destination, amount: "10.2500000" });
  });

  it("rejects secret-key fields instead of accepting or ignoring them, without echoing the value", async () => {
    mockHorizon([source, destination]);

    const res = await post()
      .send({ sourcePublicKey: source, destinationPublicKey: destination, amount: "1", sourceSecretKey: secret })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ path: "sourceSecretKey", message: expect.stringMatching(/never accepted/) })
    );
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(Horizon.Server.prototype.loadAccount).not.toHaveBeenCalled();
  });

  it("rejects unknown fields", async () => {
    const res = await post()
      .send({ sourcePublicKey: source, destinationPublicKey: destination, amount: "1", fee: "999999" })
      .expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: "fee", message: "Unknown field" }));
  });

  it.each([
    ["more than 7 decimals", "1.12345678"],
    ["zero", "0"],
    ["negative", "-1"],
    ["a JSON number", 1.5],
  ])("rejects an amount that is %s rather than rounding it", async (_label, amount) => {
    const res = await post()
      .send({ sourcePublicKey: source, destinationPublicKey: destination, amount })
      .expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: "amount" }));
  });

  it.each([
    ["sourcePublicKey", { sourcePublicKey: "not-a-key" }],
    ["sourcePublicKey", { sourcePublicKey: "M" + source.slice(1) }],
    ["destinationPublicKey", { destinationPublicKey: "G" + "A".repeat(55) }],
    ["asset", { asset: "USDC" }],
    ["memo", { memo: "x".repeat(29) }],
  ])("rejects an invalid %s", async (path, override) => {
    const res = await post()
      .send({ sourcePublicKey: source, destinationPublicKey: destination, amount: "1", ...override })
      .expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path }));
  });

  it("accepts a muxed destination", async () => {
    mockHorizon([source, destination]);
    const muxed = new StellarSdk.MuxedAccount(new StellarSdk.Account(destination, "0"), "42").accountId();

    const res = await post()
      .send({ sourcePublicKey: source, destinationPublicKey: muxed, amount: "1" })
      .expect(200);

    const tx = StellarSdk.TransactionBuilder.fromXDR(res.body.xdr, PASSPHRASE) as StellarSdk.Transaction;
    expect((tx.operations[0] as StellarSdk.Operation.Payment).destination).toBe(muxed);
  });

  it("returns 404 SOURCE_ACCOUNT_NOT_FOUND for an unfunded source", async () => {
    mockHorizon([destination]);

    const res = await post()
      .send({ sourcePublicKey: source, destinationPublicKey: destination, amount: "1" })
      .expect(404);

    expect(res.body.error.code).toBe("SOURCE_ACCOUNT_NOT_FOUND");
  });

  it("returns the same MEMO_REQUIRED error as /send for a SEP-29 destination without a memo", async () => {
    jest.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(100);
    jest.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => {
      const account = fakeAccount(id) as unknown as Record<string, unknown>;
      if (id === destination) account.data_attr = { "config.memo_required": "MQ==" };
      return account as unknown as StellarSdk.Horizon.AccountResponse;
    });

    const res = await post()
      .send({ sourcePublicKey: source, destinationPublicKey: destination, amount: "1" })
      .expect(400);

    expect(res.body.error.code).toBe("MEMO_REQUIRED");
  });
});
