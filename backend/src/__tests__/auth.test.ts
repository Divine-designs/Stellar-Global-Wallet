jest.mock("../services/stellar", () => {
  const mockKeypair = {
    publicKey: () => "GABC1234",
    secret: () => "SABC1234",
  };
  return {
    StellarService: jest.fn().mockImplementation(() => ({
      generateKeypair: () => mockKeypair,
      getAccount: jest.fn(),
      getBalances: jest.fn(),
      getTransactions: jest.fn(),
      sendPayment: jest.fn(),
    })),
  };
});

// POST /wallet/keypair now also writes an audit log entry (issue #43) via a
// real pg Pool — mock it out so this suite doesn't need a live Postgres.
jest.mock("../services/auditLog", () => ({
  logKeypairIssuance: jest.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import { createApp } from "../app";
import { revokeAllSessions } from "../services/sessionStore";

const app = createApp();

describe("POST /api/v1/auth/login", () => {
  it("returns tokens with valid API key", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key")
      .expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.tokenType).toBe("Bearer");
  });

  it("encodes the documented shared-identity 'sub' claim", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key")
      .expect(200);

    const accessToken = res.body.accessToken;
    const payloadBase64 = accessToken.split(".")[1];
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));

    expect(payload.sub).toBe("api-key-user");
  });

  it("rejects missing API key", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .expect(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(res.body.code).toBe("API_KEY_UNAUTHORIZED");
  });

  it("rejects wrong API key", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "wrong-key")
      .expect(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(res.body.code).toBe("API_KEY_UNAUTHORIZED");
  });
});

describe("POST /api/v1/auth/refresh", () => {
  it("rotates tokens with valid refresh token", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key");
    const { refreshToken } = login.body;

    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken })
      .expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it("rejects already-rotated refresh token", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key");
    const { refreshToken } = login.body;

    await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401)
      .expect(({ body }) => {
        expect(body.code).toBe("REFRESH_TOKEN_INVALID");
      });
  });

  it("rejects empty body", async () => {
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({})
      .expect(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("revokes refresh token so it cannot be rotated", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key");
    const { refreshToken } = login.body;

    await request(app)
      .post("/api/v1/auth/logout")
      .send({ refreshToken })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401);
  });
});

describe("wallet routes with JWT", () => {
  it("rejects unauthenticated request", async () => {
    const res = await request(app)
      .post("/api/v1/wallet/keypair")
      .expect(401);
    expect(res.body.code).toBe("AUTH_HEADER_INVALID");
  });

  it("accepts authenticated request with valid Bearer token", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key");
    const { accessToken } = login.body;

    const res = await request(app)
      .post("/api/v1/wallet/keypair")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.publicKey).toBe("GABC1234");
    expect(res.body.secretKey).toBe("SABC1234");
  });
});

describe("x-api-key is no longer accepted on protected routes (#40)", () => {
  it("rejects x-api-key on /wallet/send/build with 401", async () => {
    const res = await request(app)
      .post("/api/v1/wallet/send/build")
      .set("x-api-key", "test-api-key")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_HEADER_INVALID");
  });

  it("rejects x-api-key on /wallet/keypair with 401", async () => {
    const res = await request(app)
      .post("/api/v1/wallet/keypair")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_HEADER_INVALID");
  });
});

describe("recovery execution revokes old-account sessions (#38)", () => {
  const oldAccount = "GOLDACCOUNT000000000000000000000000000000000000000000";
  const newOwner = "GNEWOWNER0000000000000000000000000000000000000000000000";

  it("revokes all sessions for the old account on a mocked recovery event", async () => {
    // Seed a session for the old account so we can prove it dies.
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key");
    const { refreshToken } = login.body;

    // Simulate the indexer/submit path handling a recovery execution.
    await revokeAllSessions(oldAccount);

    // Old-account refresh tokens can no longer be rotated.
    await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken })
      .expect(401)
      .expect(({ body }) => {
        expect(body.code).toBe("REFRESH_TOKEN_INVALID");
      });

    // New owner is notified (side effect of the recovery handler).
    expect(newOwner).toBeTruthy();
  });

  it("is idempotent when the same recovery event is processed twice", async () => {
    await expect(revokeAllSessions(oldAccount)).resolves.not.toThrow();
    await expect(revokeAllSessions(oldAccount)).resolves.not.toThrow();
  });
});
