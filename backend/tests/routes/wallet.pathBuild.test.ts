import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createClientSigningRouter } from "../../src/routes/clientSigning";
import { StellarService } from "../../src/services/stellar";
import { appWithRouter, authHeader } from "../helpers/routerApp";

const { Horizon } = StellarSdk;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE as string;

const source = StellarSdk.Keypair.random().publicKey();
const destination = StellarSdk.Keypair.random().publicKey();
const issuer = StellarSdk.Keypair.random().publicKey();
const usdc = `USDC:${issuer}`;
const hop = `BTCN:${StellarSdk.Keypair.random().publicKey()}`;

function mockHorizon() {
  jest.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(100);
  jest.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => {
    const account = new StellarSdk.Account(id, "100") as unknown as Record<string, unknown>;
    if (id === destination) {
      account.balances = [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "0" }];
    }
    if (id !== source && id !== destination) throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
    return account as unknown as StellarSdk.Horizon.AccountResponse;
  });
}

const endpoints = [
  {
    endpoint: "path-payment-strict-send",
    body: (overrides: Record<string, unknown> = {}) => ({
      sourcePublicKey: source,
      destinationPublicKey: destination,
      sendAmount: "100",
      destAsset: usdc,
      quotedDestAmount: "20",
      ...overrides,
    }),
    amountFields: ["sendAmount", "quotedDestAmount"],
    expected: { expectedSend: "100.0000000", expectedReceive: "20.0000000", minReceive: "19.9000000" },
    opType: "pathPaymentStrictSend",
  },
  {
    endpoint: "path-payment-strict-receive",
    body: (overrides: Record<string, unknown> = {}) => ({
      sourcePublicKey: source,
      destinationPublicKey: destination,
      destAmount: "20",
      destAsset: usdc,
      quotedSendAmount: "100",
      ...overrides,
    }),
    amountFields: ["destAmount", "quotedSendAmount"],
    expected: { expectedSend: "100.0000000", expectedReceive: "20.0000000", maxSend: "100.5000000" },
    opType: "pathPaymentStrictReceive",
  },
];

describe.each(endpoints)("POST /api/v1/wallet/$endpoint/build (issue #3)", ({ endpoint, body, amountFields, expected, opType }) => {
  const app = appWithRouter("/api/v1/wallet", createClientSigningRouter(new StellarService()));
  const url = `/api/v1/wallet/${endpoint}/build`;
  const post = () => request(app).post(url).set(authHeader());

  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("rejects an unauthenticated request", async () => {
    await request(app).post(url).send(body()).expect(401);
  });

  it("returns the unsigned XDR with expected amounts, slippage bound and path", async () => {
    mockHorizon();

    const res = await post().send(body({ path: [hop] })).expect(200);

    expect(res.body).toMatchObject({
      networkPassphrase: PASSPHRASE,
      slippageBps: 50,
      path: [hop],
      timeBounds: { minTime: "0", maxTime: expect.any(String) },
      ...expected,
    });
    const tx = StellarSdk.TransactionBuilder.fromXDR(res.body.xdr, PASSPHRASE) as StellarSdk.Transaction;
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations[0].type).toBe(opType);
  });

  it("applies a custom slippageBps", async () => {
    mockHorizon();

    const res = await post().send(body({ slippageBps: 0 })).expect(200);

    expect(res.body.slippageBps).toBe(0);
    expect(res.body.minReceive ?? res.body.maxSend).toBeDefined();
    expect(res.body.minReceive ?? res.body.maxSend).toMatch(/^\d+\.\d{7}$/);
  });

  it("rejects secret-key fields instead of accepting them", async () => {
    const secret = StellarSdk.Keypair.random().secret();

    const res = await post().send(body({ sourceSecretKey: secret })).expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: "sourceSecretKey" }));
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it("does not accept a client-chosen destMin or sendMax", async () => {
    const res = await post().send(body({ destMin: "1", sendMax: "999" })).expect(400);

    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(["destMin", "sendMax"])
    );
  });

  it("rejects paths longer than five hops with 400", async () => {
    const res = await post().send(body({ path: Array(8).fill(hop) })).expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ path: "path", message: "Path must contain at most 5 assets" })
    );
  });

  it("rejects malformed path assets with 400", async () => {
    const res = await post().send(body({ path: ["USDC-without-an-issuer"] })).expect(400);

    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ path: "path", message: "Each path asset must use the CODE:ISSUER format" })
    );
  });

  it.each([501, -1, 1.5, "50"])("rejects slippageBps %p", async (slippageBps) => {
    const res = await post().send(body({ slippageBps })).expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: "slippageBps" }));
  });

  it.each(["1.12345678", "0", 5])("rejects an invalid amount %p without rounding it", async (bad) => {
    for (const field of amountFields) {
      const res = await post().send(body({ [field]: bad })).expect(400);
      expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: field }));
    }
  });

  it.each([
    ["sourcePublicKey", { sourcePublicKey: "G" + "A".repeat(55) }],
    ["destinationPublicKey", { destinationPublicKey: "nope" }],
    ["destAsset", { destAsset: "USDC" }],
    ["sendAsset", { sendAsset: "USDC" }],
  ])("rejects an invalid %s", async (path, override) => {
    const res = await post().send(body(override)).expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path }));
  });

  it("returns a pre-check error when the destination has no trustline for the destination asset", async () => {
    mockHorizon();
    const otherAsset = `EURT:${issuer}`;

    const res = await post().send(body({ destAsset: otherAsset })).expect(400);

    expect(res.body.error).toMatchObject({
      code: "DESTINATION_NO_TRUSTLINE",
      details: { reason: "NO_TRUSTLINE" },
    });
  });
});
