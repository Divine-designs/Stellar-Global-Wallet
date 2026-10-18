import request from "supertest";
import { createApp } from "../app";
import { NotFoundError } from "../errors/appError";
import { GlobeWalletContract } from "../services/contracts/globeWallet";
import { StellarService } from "../services/stellar";

function createMockStellar(overrides: Record<string, unknown> = {}): StellarService {
  return {
    buildPartialTransaction: jest.fn(),
    feeBumpTransaction: jest.fn(),
    feeStats: jest.fn(),
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

function expectEnvelope(body: any) {
  expect(body).toHaveProperty('error');
  expect(typeof body.error.code).toBe('string');
  expect(typeof body.error.message).toBe('string');
  expect(body.error).toHaveProperty('requestId');
  expect(body.error).not.toHaveProperty('stack');
}

describe('consistent error envelope', () => {
  const app = buildApp();

  it('returns 200 for the happy path', async () => {
    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

    expect(res.body.code).toBe("ACCOUNT_NOT_FOUND");
    expect(res.body.error).toBe("Account GTEST was not found on Horizon");
    expect(res).toSatisfyApiSpec();
  });

  it('returns 401 with the shared envelope', async () => {
    const res = await request(app).get('/unauthorized');
    expect(res.status).toBe(401);
    expectEnvelope(res.body);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 with the shared envelope', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expectEnvelope(res.body);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 413 with the shared envelope for oversized payloads', async () => {
    const res = await request(app)
      .post('/ok')
      .set('Content-Type', 'application/json')
      .send({ data: 'x'.repeat(4096) });
    expect(res.status).toBe(413);
    expectEnvelope(res.body);
  });

    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(res.body.error).toBe("Validation failed because field does not exist in payload");
    expect(res).toSatisfyApiSpec();
  });

  it('returns 500 with the shared envelope and no stack trace', async () => {
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expectEnvelope(res.body);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 400 with the shared envelope for malformed JSON', async () => {
    const res = await request(app)
      .get(`/api/v1/account/${"M".repeat(56)}`)
      .expect(400);

    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details[0].path).toBe("publicKey");
    expect(res).toSatisfyApiSpec();
  });
});
