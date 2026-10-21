import request from "supertest";
import { createApp } from "../../src/app";
import { StellarService } from "../../src/services/stellar";
import { GlobeWalletContract } from "../../src/services/contracts/globeWallet";

const ACCOUNT = "GBLIQBXTAF3O3YINCRDR5O7H47QHHW5GFOYN4HAD6IKOSWD4LWKWWPHP";
const ISSUER = "GA6HCMBLTZS5VYYBCATRBRZ3ACJRONEAZMYY5E43HAGXUTOUVCR5KVDT";

async function getAccessToken(app: import("express").Express): Promise<string> {
  const login = await request(app).post("/api/v1/auth/login").set("x-api-key", "test-api-key");
  return login.body.accessToken;
}

describe("POST /api/v1/wallet/trustline/build (#9)", () => {
  it("builds an add-trustline response with the reserve impact", async () => {
    const buildTrustlineTransaction = jest.fn().mockResolvedValue({
      xdr: "AAAA_UNSIGNED_XDR",
      networkPassphrase: "Test SDF Network ; September 2015",
      reserveDelta: "0.5",
      spendableXlmAfter: "12.4999900",
    });
    const app = createApp(
      { buildTrustlineTransaction } as unknown as StellarService,
      {} as GlobeWalletContract
    );
    const token = await getAccessToken(app);

    const res = await request(app)
      .post("/api/v1/wallet/trustline/build")
      .set("Authorization", `Bearer ${token}`)
      .send({ account: ACCOUNT, asset: { code: "USDC", issuer: ISSUER } })
      .expect(200);

    expect(res.body).toEqual({
      xdr: "AAAA_UNSIGNED_XDR",
      networkPassphrase: "Test SDF Network ; September 2015",
      reserveDelta: "0.5",
      spendableXlmAfter: "12.4999900",
    });
    expect(buildTrustlineTransaction).toHaveBeenCalledWith({
      account: ACCOUNT,
      asset: { code: "USDC", issuer: ISSUER },
      limit: undefined,
    });
  });

  it("builds the removal transaction when limit is the string zero", async () => {
    const buildTrustlineTransaction = jest.fn().mockResolvedValue({
      xdr: "AAAA_REMOVE_XDR",
      networkPassphrase: "Test SDF Network ; September 2015",
      reserveDelta: "-0.5",
      spendableXlmAfter: "13.0000000",
    });
    const app = createApp(
      { buildTrustlineTransaction } as unknown as StellarService,
      {} as GlobeWalletContract
    );
    const token = await getAccessToken(app);

    const res = await request(app)
      .post("/api/v1/wallet/trustline/build")
      .set("Authorization", `Bearer ${token}`)
      .send({ account: ACCOUNT, asset: { code: "USDC", issuer: ISSUER }, limit: "0" })
      .expect(200);

    expect(res.body.reserveDelta).toBe("-0.5");
    expect(buildTrustlineTransaction).toHaveBeenCalledWith({
      account: ACCOUNT,
      asset: { code: "USDC", issuer: ISSUER },
      limit: "0",
    });
  });

  it("rejects invalid addresses and unknown request properties before building", async () => {
    const buildTrustlineTransaction = jest.fn();
    const app = createApp(
      { buildTrustlineTransaction } as unknown as StellarService,
      {} as GlobeWalletContract
    );
    const token = await getAccessToken(app);

    await request(app)
      .post("/api/v1/wallet/trustline/build")
      .set("Authorization", `Bearer ${token}`)
      .send({
        account: `${ACCOUNT.slice(0, -1)}A`,
        asset: { code: "USDC", issuer: ISSUER },
        ignored: true,
      })
      .expect(400);

    expect(buildTrustlineTransaction).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const buildTrustlineTransaction = jest.fn();
    const app = createApp(
      { buildTrustlineTransaction } as unknown as StellarService,
      {} as GlobeWalletContract
    );

    await request(app)
      .post("/api/v1/wallet/trustline/build")
      .send({ account: ACCOUNT, asset: { code: "USDC", issuer: ISSUER } })
      .expect(401);
    expect(buildTrustlineTransaction).not.toHaveBeenCalled();
  });
});
