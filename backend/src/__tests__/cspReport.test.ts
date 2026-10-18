import request from "supertest";
import { createApp } from "../app";

const app = createApp();

describe("POST /csp-report", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("accepts the legacy report-uri shape (application/csp-report) and logs it", async () => {
    const report = {
      "csp-report": {
        "document-uri": "https://wallet.example/app",
        "violated-directive": "script-src",
        "blocked-uri": "https://evil.example/x.js",
      },
    };

    const res = await request(app)
      .post("/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(report));

    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][1];
    expect(JSON.parse(logged)["violated-directive"]).toBe("script-src");
  });

  it("accepts the Reporting API shape (application/reports+json) and logs each csp-violation entry", async () => {
    const reports = [
      {
        type: "csp-violation",
        url: "https://wallet.example/app",
        body: { violatedDirective: "connect-src", blockedURL: "https://evil.example" },
      },
      {
        // Non-CSP report types can share the same endpoint — must be
        // ignored rather than logged/crash the handler.
        type: "deprecation",
        url: "https://wallet.example/app",
        body: { id: "something-deprecated" },
      },
    ];

    const res = await request(app)
      .post("/csp-report")
      .set("Content-Type", "application/reports+json")
      .send(JSON.stringify(reports));

    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][1];
    expect(JSON.parse(logged).violatedDirective).toBe("connect-src");
  });

  it("returns 204 without logging anything for an empty/unrecognized body", async () => {
    const res = await request(app)
      .post("/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify({}));

    expect(res.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("API docs", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  it("serves Swagger UI at /api/docs and the raw spec at /api/openapi.json when enabled", async () => {
    process.env = { ...originalEnv, NODE_ENV: "test", ENABLE_API_DOCS: "true" };
    jest.resetModules();
    const { createApp: freshCreateApp } = await import("../app");
    const docsApp = freshCreateApp();

    const docsRes = await request(docsApp).get("/api/docs/").redirects(1);
    expect(docsRes.status).toBe(200);

    const specRes = await request(docsApp).get("/api/openapi.json");
    expect(specRes.status).toBe(200);
    expect(specRes.body).toHaveProperty("openapi");
  });

  it("returns 404 for /api/docs and /api/openapi.json when disabled", async () => {
    process.env = { ...originalEnv, NODE_ENV: "test", ENABLE_API_DOCS: "false" };
    jest.resetModules();
    const { createApp: freshCreateApp } = await import("../app");
    const docsApp = freshCreateApp();

    const docsRes = await request(docsApp).get("/api/docs/");
    expect(docsRes.status).toBe(404);

    const specRes = await request(docsApp).get("/api/openapi.json");
    expect(specRes.status).toBe(404);
  });
});
