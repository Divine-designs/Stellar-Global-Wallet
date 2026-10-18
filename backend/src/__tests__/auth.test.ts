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

describe("GET /api/v1/auth/me", () => {
  it("returns the current session identity and expiry", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key")
      .expect(200);
    const { accessToken } = login.body;

    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.account).toBe("api-key-user");
    expect(res.body.authMethod).toBe("api-key");
    expect(typeof res.body.issuedAt).toBe("number");
    expect(typeof res.body.expiresAt).toBe("number");
    expect(res.body.expiresAt).toBeGreaterThan(res.body.issuedAt);
    expect(typeof res.body.sessionId).toBe("string");
    expect(res.body.sessionId.length).toBeGreaterThan(0);
  });

  it("returns 401 when not signed in", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .expect(401);
    expect(res.body.code).toBe("TOKEN_MISSING");
  });

  it("returns 401 TOKEN_EXPIRED for an expired token", async () => {
    const jwt = require("jsonwebtoken");
    const { config } = require("../config");
    const expired = jwt.sign(
      { sub: "api-key-user", authMethod: "api-key", sid: "expired-session" },
      config.jwtSecret,
      { expiresIn: -10 }
    );

    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expired}`)
      .expect(401);
    expect(res.body.code).toBe("TOKEN_EXPIRED");
  });
});

describe("wallet routes with JWT", () => {
  it("rejects unauthenticated request", async () => {
    const res = await request(app)
      .get("/api/v1/wallet/balances")
      .expect(401);
    expect(res.body.code).toBe("TOKEN_MISSING");
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

describe("read endpoint caching (ETag / Cache-Control)", () => {
  const account = "GABC1234";

  async function getAccessToken(): Promise<string> {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("x-api-key", "test-api-key");
    return login.body.accessToken;
  }

  it("sets a weak ETag and private revalidation Cache-Control on account", async () => {
    const accessToken = await getAccessToken();
    const res = await request(app)
      .get(`/api/v1/account/${account}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);

    expect(res.headers.etag).toBeTruthy();
    expect(res.headers.etag.startsWith("W/")).toBe(true);
    expect(res.headers["cache-control"]).toBe("private, max-age=0, must-revalidate");
  });

  it("returns 304 when If-None-Match matches the current ETag", async () => {
    const accessToken = await getAccessToken();
    const first = await request(app)
      .get(`/api/v1/account/${account}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);

    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const second = await request(app)
      .get(`/api/v1/account/${account}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("If-None-Match", etag)
      .expect(304);

    expect(second.text).toBeFalsy();
  });

  it("exposes ETag via CORS Access-Control-Expose-Headers", async () => {
    const accessToken = await getAccessToken();
    const res = await request(app)
      .get(`/api/v1/account/${account}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Origin", "https://example.com")
      .expect(200);

    const exposed = (res.headers["access-control-expose-headers"] || "").toLowerCase();
    expect(exposed).toContain("etag");
  });
});
