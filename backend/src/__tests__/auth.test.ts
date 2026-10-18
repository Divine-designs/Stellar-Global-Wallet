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

const app = createApp();

// Cookie names used by the backend for cookie-mode sessions (issue #34).
// `__Host-` requires Secure, so on http://localhost the dev-only names are used.
const ACCESS_COOKIE = "__Host-gw_at";
const REFRESH_COOKIE = "__Host-gw_rt";
const DEV_ACCESS_COOKIE = "gw_at";
const DEV_REFRESH_COOKIE = "gw_rt";

function getSetCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function findCookie(res: request.Response, name: string): string | undefined {
  return getSetCookies(res).find((c) => c.startsWith(`${name}=`));
}

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

describe("POST /api/v1/auth/token (cookie mode)", () => {
  it("sets httpOnly access and refresh cookies with correct flags", async () => {
    const res = await request(app)
      .post("/api/v1/auth/token?mode=cookie")
      .set("x-api-key", "test-api-key")
      .expect(200);

    const access = findCookie(res, ACCESS_COOKIE) ?? findCookie(res, DEV_ACCESS_COOKIE);
    const refresh = findCookie(res, REFRESH_COOKIE) ?? findCookie(res, DEV_REFRESH_COOKIE);

    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    expect(access).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(refresh).toMatch(/SameSite=Lax/i);
    // Refresh cookie is scoped to the auth path.
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it("does not leak tokens in the JSON body in cookie mode", async () => {
    const res = await request(app)
      .post("/api/v1/auth/token?mode=cookie")
      .set("x-api-key", "test-api-key")
      .expect(200);

    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });

  it("keeps Bearer mode as the default", async () => {
    const res = await request(app)
      .post("/api/v1/auth/token")
      .set("x-api-key", "test-api-key")
      .expect(200);

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.tokenType).toBe("Bearer");
    expect(findCookie(res, ACCESS_COOKIE)).toBeUndefined();
    expect(findCookie(res, DEV_ACCESS_COOKIE)).toBeUndefined();
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

  it("rotates cookies in cookie mode using the refresh cookie", async () => {
    const login = await request(app)
      .post("/api/v1/auth/token?mode=cookie")
      .set("x-api-key", "test-api-key")
      .expect(200);

    const cookies = getSetCookies(login)
      .map((c) => c.split(";")[0])
      .join("; ");

    const res = await request(app)
      .post("/api/v1/auth/refresh?mode=cookie")
      .set("Cookie", cookies)
      .expect(200);

    const access = findCookie(res, ACCESS_COOKIE) ?? findCookie(res, DEV_ACCESS_COOKIE);
    const refresh = findCookie(res, REFRESH_COOKIE) ?? findCookie(res, DEV_REFRESH_COOKIE);
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    expect(res.body.accessToken).toBeUndefined();
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

  it("clears session cookies in cookie mode", async () => {
    const login = await request(app)
      .post("/api/v1/auth/token?mode=cookie")
      .set("x-api-key", "test-api-key")
      .expect(200);

    const cookies = getSetCookies(login)
      .map((c) => c.split(";")[0])
      .join("; ");

    const res = await request(app)
      .post("/api/v1/auth/logout?mode=cookie")
      .set("Cookie", cookies)
      .expect(200);

    const cleared = getSetCookies(res);
    const access = cleared.find(
      (c) => c.startsWith(`${ACCESS_COOKIE}=`) || c.startsWith(`${DEV_ACCESS_COOKIE}=`)
    );
    const refresh = cleared.find(
      (c) => c.startsWith(`${REFRESH_COOKIE}=`) || c.startsWith(`${DEV_REFRESH_COOKIE}=`)
    );
    expect(access).toBeTruthy();
    expect(refresh).toBeTruthy();
    // Cleared cookies expire immediately.
    expect(access).toMatch(/Expires=Thu, 01 Jan 1970/i);
    expect(refresh).toMatch(/Expires=Thu, 01 Jan 1970/i);
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

  it("accepts authenticated request via access cookie", async () => {
    const login = await request(app)
      .post("/api/v1/auth/token?mode=cookie")
      .set("x-api-key", "test-api-key")
      .expect(200);

    const accessCookie = getSetCookies(login)
      .map((c) => c.split(";")[0])
      .find(
        (c) => c.startsWith(`${ACCESS_COOKIE}=`) || c.startsWith(`${DEV_ACCESS_COOKIE}=`)
      );
    expect(accessCookie).toBeTruthy();

    const res = await request(app)
      .post("/api/v1/wallet/keypair")
      .set("Cookie", accessCookie as string)
      .expect(200);
    expect(res.body.publicKey).toBe("GABC1234");
  });
});
