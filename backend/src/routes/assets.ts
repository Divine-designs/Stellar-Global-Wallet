import { Router } from "express";
import { param, query } from "express-validator";
import { assertValidRequest } from "../middleware/requestValidation";
import { ValidationError } from "../errors/appError";
import { AssetMetadataService } from "../services/assetMetadata";
import {
  AssetSearchService,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from "../services/assetSearch";
import { isValidPublicHostname } from "../services/safeHttpsFetch";
import { isGAddress, publicKeyMessage } from "../utils/stellarAddress";

const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;
const ASSET_CODE_MESSAGE = "must be a 1-12 character alphanumeric asset code";
// Horizon asset paging tokens look like `USDC_G..._credit_alphanum4`.
const CURSOR_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

/**
 * Asset discovery for the add-trustline flow.
 *
 * Both routes are unauthenticated reads over public network data (Horizon
 * and issuers' public stellar.toml files), like GET /contract/admin.
 */
export function createAssetsRouter(
  search: AssetSearchService = new AssetSearchService(),
  metadata: AssetMetadataService = new AssetMetadataService()
): Router {
  const router = Router();

  // #53 — search by code (Horizon, paginated) or by domain (stellar.toml).
  router.get(
    "/search",
    query("code").optional().isString().matches(ASSET_CODE_PATTERN).withMessage(ASSET_CODE_MESSAGE),
    query("domain")
      .optional()
      .isString()
      .custom((value: string) => isValidPublicHostname(value.trim().toLowerCase()))
      .withMessage("must be a public DNS hostname, e.g. circle.com"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: MAX_SEARCH_LIMIT })
      .withMessage(`must be an integer between 1 and ${MAX_SEARCH_LIMIT}`)
      .toInt(),
    query("cursor").optional().isString().matches(CURSOR_PATTERN).withMessage("must be a cursor returned by a previous page"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const code = req.query.code as string | undefined;
        const domain = req.query.domain as string | undefined;
        if ((code === undefined) === (domain === undefined)) {
          throw new ValidationError([
            { location: "query", path: "code", message: "provide exactly one of `code` or `domain`" },
          ]);
        }
        if (domain !== undefined && req.query.cursor !== undefined) {
          throw new ValidationError([
            { location: "query", path: "cursor", message: "`cursor` is only supported with `code`" },
          ]);
        }

        const page =
          code !== undefined
            ? await search.searchByCode({
                code,
                limit: (req.query.limit as unknown as number | undefined) ?? DEFAULT_SEARCH_LIMIT,
                cursor: req.query.cursor as string | undefined,
              })
            : await search.searchByDomain(domain as string);
        res.json(page);
      } catch (err) {
        next(err);
      }
    }
  );

  // #52 — name/icon/decimals/home domain from the issuer's stellar.toml.
  router.get(
    "/:code/:issuer",
    param("code").matches(ASSET_CODE_PATTERN).withMessage(ASSET_CODE_MESSAGE),
    param("issuer").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const result = await metadata.getMetadata(req.params.code, req.params.issuer);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
