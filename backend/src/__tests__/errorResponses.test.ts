import request from "supertest";
import { createApp } from "../app";
import { NotFoundError } from "../errors/appError";
import { GlobeWalletContract } from "../services/contracts/globeWallet";
import { StellarService } from "../services/stellar";

function createMockStellar(overrides: Record<string, unknown> = {}): StellarService {
  return {
    buildPartialTransaction: jest.fn(),
    feeBumpTransaction: jest.fn(),
    findStrictReceivePaths: jest.fn(),
    findStrictSendPaths: jest.fn(),
    generateKeypair: jest.fn(),
    getAccount: jest.fn(),
    getAccountThresholds: jest.fn(),
    getBalances: jest.fn(),
    getTransactions: jest.fn(),
    pathPaymentStrictReceive: jest.fn(),
    pathPaymentStrictSend: jest.fn(),
    sendPayment: jest.fn(),
    submitWithAdditionalSignatures: jest.fn(),
    ...overrides,
  } as unknown as StellarService;
}

function createMockContract(): GlobeWalletContract {
  return {} as GlobeWalletContract;
}

describe("error responses", () => {
  it("returns a typed 404 for not found domain errors", async () => {
    const app = createApp(
      createMockStellar({
        getAccount: jest.fn().mockRejectedValue(
          new NotFoundError("Account GTEST was not found on Horizon", "ACCOUNT_NOT_FOUND")
        ),
      }),
      createMockContract()
    );

    const res = await request(app)
      .get(`/api/v1/account/${"G".repeat(56)}`)
      .expect(404);

    expect(res.body.code).toBe("ACCOUNT_NOT_FOUND");
    expect(res.body.error).toBe("Account GTEST was not found on Horizon");
    expect(res).toSatisfyApiSpec();
  });

  it("does not infer 404 from an unrelated error message substring", async () => {
    const app = createApp(
      createMockStellar({
        getAccount: jest
          .fn()
          .mockRejectedValue(new Error("Validation failed because field does not exist in payload")),
      }),
      createMockContract()
    );

    const res = await request(app)
      .get(`/api/v1/account/${"G".repeat(56)}`)
      .expect(500);

    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(res.body.error).toBe("Validation failed because field does not exist in payload");
    expect(res).toSatisfyApiSpec();
  });

  it("returns a typed validation error body for invalid account parameters", async () => {
    const app = createApp(createMockStellar(), createMockContract());

    const res = await request(app)
      .get(`/api/v1/account/${"M".repeat(56)}`)
      .expect(400);

    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details[0].path).toBe("publicKey");
    expect(res).toSatisfyApiSpec();
  });
});
