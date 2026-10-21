import request from "supertest";
import { createApp } from "../../src/app";
import { StellarService } from "../../src/services/stellar";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";
import { config } from "../../src/config";

describe("GET /api/v1/config and /config (issue #81)", () => {
  it("returns network parameters and null pending upgrade when none is queued", async () => {
    const stellar = {} as unknown as StellarService;
    const globeWallet = {
      getPendingUpgrade: jest.fn().mockResolvedValue(null),
    } as unknown as GlobeWalletContract;

    const app = createApp(stellar, globeWallet);
    const secretValues = {
      JWT_SECRET: "config-test-jwt-secret-should-never-be-public",
      API_KEY: "config-test-api-key-should-never-be-public",
      DATABASE_URL: "postgres://config-test-secret-should-never-be-public",
    };
    const previousSecrets = Object.fromEntries(
      Object.keys(secretValues).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, secretValues);

    try {
      const res = await request(app).get("/api/v1/config").expect(200);

      expect(res.body).toHaveProperty("network");
      expect(res.body).toHaveProperty("networkPassphrase");
      expect(res.body).toHaveProperty("horizonUrl");
      expect(res.body).toHaveProperty("sorobanRpcUrl");
      expect(res.body).toHaveProperty("apiVersion");
      expect(res.body).toHaveProperty("minClientVersion");
      expect(res.body).toHaveProperty("contracts");
      expect(res.body.contracts.globeWallet.pendingUpgrade).toBeNull();
      expect(res.body.contracts.tokenWrapper).toBeNull();
      expect(res.body.features.contract).toBe(true);
      expect(res.headers["cache-control"]).toBe("public, max-age=60");

      const serialized = JSON.stringify(res.body);
      Object.values(secretValues).forEach((secret) => {
        expect(serialized).not.toContain(secret);
      });

      // Verify alias /config behaves identically
      const aliasRes = await request(app).get("/config").expect(200);
      expect(aliasRes.body).toEqual(res.body);
    } finally {
      Object.entries(previousSecrets).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    }
  });

  it("exposes pending upgrade details and ETA when an upgrade is queued", async () => {
    const stellar = {} as unknown as StellarService;
    const pendingUpgradeData = {
      wasmHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      proposedBy: "GBZH7QMRVYFLVYQRY6O5SOM3G7MSQF7MMUEM3WUOGRV26W3R3K5M7G8A",
      readyAtLedger: 50000,
      executableAt: "2026-10-18T12:00:00.000Z",
    };

    const globeWallet = {
      getPendingUpgrade: jest.fn().mockResolvedValue(pendingUpgradeData),
    } as unknown as GlobeWalletContract;

    const app = createApp(stellar, globeWallet);

    const res = await request(app).get("/api/v1/config").expect(200);

    expect(res.body.contracts.globeWallet.pendingUpgrade).toEqual(pendingUpgradeData);
  });

  it("returns a null wallet contract and disables the contract feature when unset", async () => {
    const previous = config.GLOBE_WALLET_CONTRACT_ID;
    config.GLOBE_WALLET_CONTRACT_ID = undefined;
    const getPendingUpgrade = jest.fn();
    const app = createApp(
      {} as StellarService,
      { getPendingUpgrade } as unknown as GlobeWalletContract
    );

    try {
      const res = await request(app).get("/api/v1/config").expect(200);
      expect(res.body.contracts.globeWallet.contractId).toBeNull();
      expect(res.body.features.contract).toBe(false);
      expect(getPendingUpgrade).not.toHaveBeenCalled();
    } finally {
      config.GLOBE_WALLET_CONTRACT_ID = previous;
    }
  });
});
