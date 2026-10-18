import { Router } from "express";
import { config } from "../config";
import { getVerifiedAssets } from "../services/verifiedAssets";

export const assetsRouter = Router();

/**
 * GET /api/v1/assets/verified (#54)
 *
 * The maintainer-reviewed allowlist of issued assets for the configured
 * network (backend/data/verified-assets.<network>.json). Native XLM is
 * always trusted and is not listed. Clients should match on BOTH `code`
 * and `issuer` — a matching code alone is exactly what a lookalike scam
 * asset looks like.
 *
 * Public and unauthenticated: the list is the same for every caller and
 * is needed before sign-in (e.g. to render a receive screen).
 */
assetsRouter.get("/verified", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    network: config.STELLAR_NETWORK,
    assets: getVerifiedAssets().map(({ code, issuer, domain, name }) => ({ code, issuer, domain, name })),
  });
});
