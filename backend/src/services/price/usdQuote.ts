import { config } from "../../config";
import { getVerifiedAssets } from "../verifiedAssets";

export interface UsdQuoteAsset {
  code: string;
  issuer: string;
}

/**
 * The USD stablecoin every DEX price is quoted against: `PRICE_USDC_ISSUER`
 * if set, otherwise the verified asset flagged `usdPeg: true` for the
 * configured network (Circle USDC on both testnet and mainnet).
 */
export function resolveUsdQuoteAsset(): UsdQuoteAsset {
  if (config.PRICE_USDC_ISSUER) {
    return { code: "USDC", issuer: config.PRICE_USDC_ISSUER };
  }
  const peg = getVerifiedAssets().find((a) => a.usdPeg);
  if (!peg) {
    throw new Error(
      `No USD quote asset: set PRICE_USDC_ISSUER or mark one asset usdPeg in verified-assets.${config.STELLAR_NETWORK}.json`
    );
  }
  return { code: peg.code, issuer: peg.issuer };
}

export function isUsdQuoteAsset(code: string, issuer: string, quote: UsdQuoteAsset): boolean {
  return code === quote.code && issuer === quote.issuer;
}
