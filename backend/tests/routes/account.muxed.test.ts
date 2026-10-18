jest.mock("../../src/services/stellar", () => {
  return {
    StellarService: jest.fn().mockImplementation(() => ({
      generateKeypair: () => ({
        publicKey: () => "GABC1234",
        secret: () => "SABC1234",
      }),
      getAccount: jest.fn().mockResolvedValue({
        account_id: "GABC1234",
        balances: [],
      }),
      getBalances: jest.fn().mockResolvedValue({ XLM: "100" }),
      getTransactions: jest.fn().mockResolvedValue({
        transactions: [],
        next: undefined,
        hasMore: false,
      }),
      sendPayment: jest.fn().mockResolvedValue({ hash: "hash", successful: true }),
      feeBumpTransaction: jest.fn().mockResolvedValue({ hash: "hash", successful: true }),
      destinationRequiresMemo: jest.fn().mockResolvedValue(false),
    })),
  };
});

jest.mock("../../src/services/auditLog", () => ({
  logKeypairIssuance: jest.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("Account routes muxed-address rejection (issue #5)", () => {
  const G_ADDRESS = "GBZH7QMRVYFLVYQRY6O5SOM3G7MSQF7MMUEM3WUOGRV26W3R3K5M7G8A";
  // Muxed address: starts with M, same 56-char length
  const M_ADDRESS = "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7345A";

  it("accepts a G... address on GET /:publicKey", async () => {
    const res = await request(app)
      .get(`/api/v1/account/${G_ADDRESS}`)
      .expect(200);
    expect(res.body.account_id).toBe("GABC1234");
  });

  it("rejects an M... address on GET /:publicKey with 400", async () => {
    const res = await request(app)
      .get(`/api/v1/account/${M_ADDRESS}`)
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details[0].path).toBe("publicKey");
    expect(res.body.details[0].message).toContain("Muxed");
  });

  it("accepts a G... address on GET /:publicKey/balances", async () => {
    const res = await request(app)
      .get(`/api/v1/account/${G_ADDRESS}/balances`)
      .expect(200);
    expect(res.body.balances).toBeDefined();
  });

  it("rejects an M... address on GET /:publicKey/balances with 400", async () => {
    const res = await request(app)
      .get(`/api/v1/account/${M_ADDRESS}/balances`)
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details[0].path).toBe("publicKey");
    expect(res.body.details[0].message).toContain("Muxed");
  });

  it("accepts a G... address on GET /:publicKey/transactions", async () => {
    const res = await request(app)
      .get(`/api/v1/account/${G_ADDRESS}/transactions`)
      .expect(200);
    expect(res.body.transactions).toBeDefined();
  });

  it("rejects an M... address on GET /:publicKey/transactions with 400", async () => {
    const res = await request(app)
      .get(`/api/v1/account/${M_ADDRESS}/transactions`)
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details[0].path).toBe("publicKey");
    expect(res.body.details[0].message).toContain("Muxed");
  });
});

describe("Wallet /send muxed-address rejection (issue #5)", () => {
  const M_ADDRESS = "M" + "A".repeat(55);

  it("rejects M... destination with 400", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key");
    const { accessToken } = login.body;

    const res = await request(app)
      .post("/api/v1/wallet/send")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        sourceSecretKey: "S".repeat(56),
        destinationPublicKey: M_ADDRESS,
        amount: "10",
      })
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toEqual([
      expect.objectContaining({
        path: "destinationPublicKey",
      }),
    ]);
    expect(res.body.details[0].message).toContain("Muxed");
  });
});

describe("Wallet muxed-account receive endpoint (issue #71)", () => {
  const G_ADDRESS = "GBZH7QMRVYFLVYQRY6O5SOM3G7MSQF7MMUEM3WUOGRV26W3R3K5M7G8A";

  async function getAccessToken(): Promise<string> {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key");
    return login.body.accessToken;
  }

  it("returns an M address for a valid id", async () => {
    const accessToken = await getAccessToken();
    const res = await request(app)
      .post(`/api/v1/wallet/${G_ADDRESS}/muxed`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ id: "123" })
      .expect(200);
    expect(typeof res.body.muxedAccount).toBe("string");
    expect(res.body.muxedAccount.startsWith("M")).toBe(true);
    expect(res.body.muxedAccount).toHaveLength(69);
    expect(res.body.baseAccount).toBe(G_ADDRESS);
    expect(res.body.id).toBe("123");
  });

  it("rejects a non-numeric id with 400", async () => {
    const accessToken = await getAccessToken();
    const res = await request(app)
      .post(`/api/v1/wallet/${G_ADDRESS}/muxed`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ id: "not-a-number" })
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details[0].path).toBe("id");
  });

  it("rejects an id outside the uint64 range with 400", async () => {
    const accessToken = await getAccessToken();
    const res = await request(app)
      .post(`/api/v1/wallet/${G_ADDRESS}/muxed`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ id: "18446744073709551616" })
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details[0].path).toBe("id");
  });

  it("rejects an invalid public key with 400", async () => {
    const accessToken = await getAccessToken();
    const res = await request(app)
      .post("/api/v1/wallet/NOTAVALIDKEY/muxed")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ id: "1" })
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details[0].path).toBe("publicKey");
  });

  it("rejects a request without auth with 401", async () => {
    const res = await request(app)
      .post(`/api/v1/wallet/${G_ADDRESS}/muxed`)
      .send({ id: "1" })
      .expect(401);
    expect(res.body.code).toBeDefined();
  });
});
