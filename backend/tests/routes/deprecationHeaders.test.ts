import request from "supertest";
import { createApp } from "../../src/app";
import { StellarService } from "../../src/services/stellar";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";

describe("legacy secret-key route deprecation headers (#11)", () => {
  it.each([
    "/api/v1/wallet/send",
    "/api/v1/wallet/fee-bump",
    "/api/v1/wallet/path-payment-strict-send",
    "/api/v1/wallet/path-payment-strict-receive",
    "/api/v1/wallet/partial-transaction",
    "/api/v1/wallet/keypair",
    "/api/v1/contract/wallet/spend",
  ])("sets deprecation headers on %s", async (path) => {
    const app = createApp(
      {} as StellarService,
      {} as GlobeWalletContract
    );
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const res = await request(app).post(path).send({}).expect(401);
      expect(res.headers.deprecation).toBe("@1798761600");
      expect(res.headers.sunset).toBe("Fri, 01 Jan 2027 00:00:00 GMT");
      expect(res.headers.link).toBe('</docs/client-signing>; rel="deprecation"');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
