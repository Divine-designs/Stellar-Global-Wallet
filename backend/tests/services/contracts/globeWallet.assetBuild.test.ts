import * as StellarSdk from "@stellar/stellar-sdk";
import { GlobeWalletContract } from "../../../src/services/contracts/globeWallet";
import { SorobanService } from "../../../src/services/soroban";

const USER = StellarSdk.Keypair.random().publicKey();
const ISSUER = StellarSdk.Keypair.random().publicKey();

describe("GlobeWalletContract asset builders (#8)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("encodes the AssetInfo struct and builds add_asset XDR", async () => {
    const buildUnsignedTransaction = jest
      .spyOn(SorobanService.prototype, "buildUnsignedTransaction")
      .mockResolvedValue("AAAA_ADD_ASSET_XDR");
    const contract = new GlobeWalletContract(new SorobanService());
    jest.spyOn(contract, "getAssets").mockResolvedValue([]);

    const xdr = await contract.buildAddAssetTx({
      user: USER,
      asset: { code: "USDC", issuer: ISSUER },
    });

    expect(xdr).toBe("AAAA_ADD_ASSET_XDR");
    const call = buildUnsignedTransaction.mock.calls[0][0];
    expect(call.method).toBe("add_asset");
    expect(call.sourcePublicKey).toBe(USER);
    expect(StellarSdk.scValToNative(call.args[0])).toBe(USER);
    const entries = call.args[1].scvMap();
    expect(entries.map((entry) => entry.key().sym())).toEqual(["code", "issuer"]);
    expect(StellarSdk.scValToNative(entries[0].val())).toBe("USDC");
    expect(StellarSdk.scValToNative(entries[1].val())).toBe(ISSUER);
  });

  it("encodes native XLM with a void issuer", async () => {
    const buildUnsignedTransaction = jest
      .spyOn(SorobanService.prototype, "buildUnsignedTransaction")
      .mockResolvedValue("AAAA_XLM_XDR");
    const contract = new GlobeWalletContract(new SorobanService());
    jest.spyOn(contract, "getAssets").mockResolvedValue([]);

    await contract.buildAddAssetTx({
      user: USER,
      asset: { code: "XLM", issuer: null },
    });

    const assetInfo = buildUnsignedTransaction.mock.calls[0][0].args[1];
    const entries = assetInfo.scvMap();
    expect(entries[0].key().sym()).toBe("code");
    expect(entries[1].key().sym()).toBe("issuer");
    expect(entries[1].val().switch()).toBe(StellarSdk.xdr.ScValType.scvVoid);
  });

  it("rejects an asset that is already registered, case-insensitively", async () => {
    const contract = new GlobeWalletContract(new SorobanService());
    jest.spyOn(contract, "getAssets").mockResolvedValue([
      { code: "USDC", issuer: ISSUER },
    ]);
    const buildUnsignedTransaction = jest.spyOn(
      SorobanService.prototype,
      "buildUnsignedTransaction"
    );

    await expect(
      contract.buildAddAssetTx({
        user: USER,
        asset: { code: "usdc", issuer: ISSUER },
      })
    ).rejects.toMatchObject({ code: "ASSET_ALREADY_ADDED" });
    expect(buildUnsignedTransaction).not.toHaveBeenCalled();
  });

  it("rejects removal while the asset has an active spend limit", async () => {
    const contract = new GlobeWalletContract(new SorobanService());
    const allowanceSpy = jest
      .spyOn(contract, "getSpendAllowance")
      .mockResolvedValue({
        assetCode: "USDC",
        unlimited: false,
        limit: "100",
        spent: "0",
        remaining: "100",
        windowStartsAt: "2026-10-20T00:00:00.000Z",
        windowResetsAt: "2026-10-21T00:00:00.000Z",
      });
    const buildUnsignedTransaction = jest.spyOn(
      SorobanService.prototype,
      "buildUnsignedTransaction"
    );

    await expect(
      contract.buildRemoveAssetTx({ user: USER, assetCode: "USDC" })
    ).rejects.toMatchObject({ code: "ASSET_HAS_ACTIVE_SPEND_LIMIT" });
    expect(allowanceSpy).toHaveBeenCalledWith(USER, "USDC");
    expect(buildUnsignedTransaction).not.toHaveBeenCalled();
  });

  it("builds remove_asset XDR when the asset has no active limit", async () => {
    const contract = new GlobeWalletContract(new SorobanService());
    jest.spyOn(contract, "getSpendAllowance").mockResolvedValue({
      assetCode: "USDC",
      unlimited: true,
      limit: "0",
      spent: "0",
      remaining: null,
      windowStartsAt: "2026-10-20T00:00:00.000Z",
      windowResetsAt: "2026-10-21T00:00:00.000Z",
    });
    const buildUnsignedTransaction = jest
      .spyOn(SorobanService.prototype, "buildUnsignedTransaction")
      .mockResolvedValue("AAAA_REMOVE_ASSET_XDR");

    const xdr = await contract.buildRemoveAssetTx({ user: USER, assetCode: "USDC" });

    expect(xdr).toBe("AAAA_REMOVE_ASSET_XDR");
    expect(buildUnsignedTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "remove_asset",
        sourcePublicKey: USER,
        args: [
          StellarSdk.nativeToScVal(USER, { type: "address" }),
          StellarSdk.nativeToScVal("USDC", { type: "string" }),
        ],
      })
    );
  });
});
