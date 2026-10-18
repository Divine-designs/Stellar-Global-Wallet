import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const BASE_ENV = {
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  DATABASE_URL: "postgres://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "test-secret",
  API_KEY: "test-api-key",
};

async function loadConfig(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key in BASE_ENV || key === "CORS_ORIGIN" || key === "CORS_ORIGIN_REGEX") {
      delete process.env[key];
    }
  }
  Object.assign(process.env, BASE_ENV, overrides);
  return import("../config");
}

describe("config CORS validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("splits, trims and accepts valid origins", async () => {
    const { config } = await loadConfig({
      CORS_ORIGIN: "https://app.example.com, https://admin.example.com",
    });
    expect(config.CORS_ORIGINS).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });

  it("keeps exp:// origins supported for Expo dev", async () => {
    const { config } = await loadConfig({
      CORS_ORIGIN: "exp://192.168.1.10:8081",
    });
    expect(config.CORS_ORIGINS).toEqual(["exp://192.168.1.10:8081"]);
  });

  it("fails startup on an origin missing a scheme", async () => {
    await expect(
      loadConfig({ CORS_ORIGIN: "app.example.com" })
    ).rejects.toThrow(/CORS_ORIGIN: invalid origin/);
  });

  it("fails startup on an empty origin list", async () => {
    await expect(loadConfig({ CORS_ORIGIN: " , " })).rejects.toThrow(
      /CORS_ORIGIN: must contain at least one origin/
    );
  });

  it("compiles a valid CORS_ORIGIN_REGEX", async () => {
    const { config } = await loadConfig({
      CORS_ORIGIN: "https://app.example.com",
      CORS_ORIGIN_REGEX: "^https://globe-wallet-[a-z0-9-]+\\.vercel\\.app$",
    });
    expect(config.CORS_ORIGIN_PATTERN).toBeInstanceOf(RegExp);
    expect(
      config.CORS_ORIGIN_PATTERN?.test("https://globe-wallet-pr-42.vercel.app")
    ).toBe(true);
  });

  it("fails startup on an invalid CORS_ORIGIN_REGEX", async () => {
    await expect(
      loadConfig({
        CORS_ORIGIN: "https://app.example.com",
        CORS_ORIGIN_REGEX: "([",
      })
    ).rejects.toThrow(/CORS_ORIGIN_REGEX: invalid regular expression/);
  });
});
