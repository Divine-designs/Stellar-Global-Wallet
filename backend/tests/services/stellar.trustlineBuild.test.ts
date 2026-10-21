import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../../src/config";
import { StellarService } from "../../src/services/stellar";

const ACCOUNT = StellarSdk.Keypair.random().publicKey();
const ISSUER = StellarSdk.Keypair.random().publicKey();

function horizonAccount(
  balance: string,
  assetBalance?: string,
  sponsor?: string
): StellarSdk.Horizon.AccountResponse {
  const account = new StellarSdk.Account(ACCOUNT, "1") as unknown as Record<string, unknown>;
  account.balances = [
    { asset_type: "native", balance, selling_liabilities: "0" },
    ...(assetBalance === undefined
      ? []
      : [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: assetBalance,
            selling_liabilities: "0",
            ...(sponsor ? { sponsor } : {}),
          },
        ]),
  ];
  account.subentry_count = assetBalance === undefined ? 0 : 1;
  account.num_sponsored = sponsor ? 1 : 0;
  return account as unknown as StellarSdk.Horizon.AccountResponse;
}

describe("StellarService.buildTrustlineTransaction (#9)", () => {
  let stellar: StellarService;

  beforeEach(() => {
    stellar = new StellarService();
    jest.spyOn(stellar, "loadAccountOrNull").mockResolvedValue({} as StellarSdk.Horizon.AccountResponse);
  });

  afterEach(() => jest.restoreAllMocks());

  it("builds an add trustline transaction and reports the reserve delta", async () => {
    jest.spyOn(stellar, "getAccount").mockResolvedValue(horizonAccount("2"));

    const result = await stellar.buildTrustlineTransaction({
      account: ACCOUNT,
      asset: { code: "USDC", issuer: ISSUER },
    });
    const transaction = new StellarSdk.Transaction(result.xdr, config.NETWORK_PASSPHRASE);

    expect(transaction.operations[0].type).toBe("changeTrust");
    expect((transaction.operations[0] as StellarSdk.ChangeTrustOperation).limit).toBe(
      "922337203685.4775807"
    );
    expect(result.reserveDelta).toBe("0.5");
    expect(result.spendableXlmAfter).toBe("0.4999900");
  });

  it("allows removal only for an existing zero-balance trustline", async () => {
    jest.spyOn(stellar, "getAccount").mockResolvedValue(horizonAccount("2", "0"));

    const result = await stellar.buildTrustlineTransaction({
      account: ACCOUNT,
      asset: { code: "USDC", issuer: ISSUER },
      limit: "0.0",
    });
    const transaction = new StellarSdk.Transaction(result.xdr, config.NETWORK_PASSPHRASE);

    expect((transaction.operations[0] as StellarSdk.ChangeTrustOperation).limit).toBe("0");
    expect(result.reserveDelta).toBe("-0.5");
    expect(result.spendableXlmAfter).toBe("0.9999900");
  });

  it("does not claim a reserve release for a sponsored trustline", async () => {
    jest.spyOn(stellar, "getAccount").mockResolvedValue(horizonAccount("2", "0", ISSUER));

    const result = await stellar.buildTrustlineTransaction({
      account: ACCOUNT,
      asset: { code: "USDC", issuer: ISSUER },
      limit: "0",
    });

    expect(result.reserveDelta).toBe("0");
    expect(result.spendableXlmAfter).toBe("0.9999900");
  });

  it("rejects removing a trustline that still holds the asset", async () => {
    jest.spyOn(stellar, "getAccount").mockResolvedValue(horizonAccount("2", "0.0000001"));

    await expect(
      stellar.buildTrustlineTransaction({
        account: ACCOUNT,
        asset: { code: "USDC", issuer: ISSUER },
        limit: "0",
      })
    ).rejects.toMatchObject({ code: "TRUSTLINE_HAS_BALANCE" });
  });

  it("rejects additions whose additional reserve exceeds spendable XLM", async () => {
    jest.spyOn(stellar, "getAccount").mockResolvedValue(horizonAccount("1.4"));

    await expect(
      stellar.buildTrustlineTransaction({
        account: ACCOUNT,
        asset: { code: "USDC", issuer: ISSUER },
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_RESERVE" });
  });

  it("reports a missing issuer before building", async () => {
    jest.spyOn(stellar, "loadAccountOrNull").mockResolvedValue(null);
    const getAccount = jest.spyOn(stellar, "getAccount");

    await expect(
      stellar.buildTrustlineTransaction({
        account: ACCOUNT,
        asset: { code: "USDC", issuer: ISSUER },
      })
    ).rejects.toMatchObject({ code: "ASSET_ISSUER_NOT_FOUND" });
    expect(getAccount).not.toHaveBeenCalled();
  });
});
