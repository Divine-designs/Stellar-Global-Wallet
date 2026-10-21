import request from "supertest";
import { createApp } from "../../src/app";
import { StellarService } from "../../src/services/stellar";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";

const USER = "GBLIQBXTAF3O3YINCRDR5O7H47QHHW5GFOYN4HAD6IKOSWD4LWKWWPHP";
const ISSUER = "GA6HCMBLTZS5VYYBCATRBRZ3ACJRONEAZMYY5E43HAGXUTOUVCR5KVDT";

async function getAccessToken(app: import("express").Express): Promise<string> {
  const login = await request(app).post("/api/v1/auth/login").set("x-api-key", "test-api-key");
  return login.body.accessToken;
}

function appWith(wallet: Partial<GlobeWalletContract>) {
  return createApp({} as StellarService, wallet as GlobeWalletContract);
}

describe("wallet asset contract builders (#8)", () => {
  it("builds unsigned XDR to add a valid issued asset", async () => {
    const buildAddAssetTx = jest.fn().mockResolvedValue("AAAA_ADD_ASSET_XDR");
    const app = appWith({ buildAddAssetTx });
    const token = await getAccessToken(app);

    const res = await request(app)
      .post("/api/v1/contract/wallet/assets/build")
      .set("Authorization", `Bearer ${token}`)
      .send({ user: USER, asset: { code: "USDC", issuer: ISSUER } })
      .expect(200);

    expect(res.body).toEqual({ xdr: "AAAA_ADD_ASSET_XDR" });
    expect(buildAddAssetTx).toHaveBeenCalledWith({
      user: USER,
      asset: { code: "USDC", issuer: ISSUER },
    });
  });

  it("allows native XLM only with a null issuer", async () => {
    const buildAddAssetTx = jest.fn().mockResolvedValue("AAAA_XLM_XDR");
    const app = appWith({ buildAddAssetTx });
    const token = await getAccessToken(app);

    await request(app)
      .post("/api/v1/contract/wallet/assets/build")
      .set("Authorization", `Bearer ${token}`)
      .send({ user: USER, asset: { code: "XLM", issuer: null } })
      .expect(200);

    expect(buildAddAssetTx).toHaveBeenCalledWith({
      user: USER,
      asset: { code: "XLM", issuer: null },
    });
  });

  it("rejects invalid asset information before calling the builder", async () => {
    const buildAddAssetTx = jest.fn();
    const app = appWith({ buildAddAssetTx });
    const token = await getAccessToken(app);

    await request(app)
      .post("/api/v1/contract/wallet/assets/build")
      .set("Authorization", `Bearer ${token}`)
      .send({ user: USER, asset: { code: "TOO-LONG-ASSET-CODE", issuer: "not-an-address" } })
      .expect(400);

    expect(buildAddAssetTx).not.toHaveBeenCalled();
  });

  it("builds unsigned XDR to remove an asset by code", async () => {
    const buildRemoveAssetTx = jest.fn().mockResolvedValue("AAAA_REMOVE_ASSET_XDR");
    const app = appWith({ buildRemoveAssetTx });
    const token = await getAccessToken(app);

    const res = await request(app)
      .post("/api/v1/contract/wallet/assets/remove/build")
      .set("Authorization", `Bearer ${token}`)
      .send({ user: USER, assetCode: "USDC" })
      .expect(200);

    expect(res.body).toEqual({ xdr: "AAAA_REMOVE_ASSET_XDR" });
    expect(buildRemoveAssetTx).toHaveBeenCalledWith({ user: USER, assetCode: "USDC" });
  });

  it("requires authentication for both builders", async () => {
    const buildAddAssetTx = jest.fn();
    const buildRemoveAssetTx = jest.fn();
    const app = appWith({ buildAddAssetTx, buildRemoveAssetTx });

    await request(app)
      .post("/api/v1/contract/wallet/assets/build")
      .send({ user: USER, asset: { code: "USDC", issuer: ISSUER } })
      .expect(401);
    await request(app)
      .post("/api/v1/contract/wallet/assets/remove/build")
      .send({ user: USER, assetCode: "USDC" })
      .expect(401);

    expect(buildAddAssetTx).not.toHaveBeenCalled();
    expect(buildRemoveAssetTx).not.toHaveBeenCalled();
  });
});
