import { Router } from "express";
import { query } from "express-validator";
import { jwtAuth } from "../middleware/jwtAuth";
import { assertValidRequest } from "../middleware/requestValidation";
import { FederationService, isResolvableAddress } from "../services/federation";

/**
 * #63 — GET /api/v1/resolve?q=<G... | M... | name*domain.com>
 * Returns `{ type, accountId, memo?, memoType?, muxedId?, muxedAddress? }`.
 */
export function createResolveRouter(federation: FederationService = new FederationService()): Router {
  const resolveRouter = Router();

  resolveRouter.use(jwtAuth);

  resolveRouter.get(
    "/",
    query("q")
      .isString()
      .bail()
      .trim()
      .isLength({ min: 1, max: 256 })
      .bail()
      .custom(isResolvableAddress)
      .withMessage(
        "q must be a Stellar account (G...), a muxed account (M...) or a federation address (name*domain.com)"
      ),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const result = await federation.resolveAddress(req.query.q as string);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return resolveRouter;
}
