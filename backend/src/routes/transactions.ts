import { Router } from "express";
import { param, query } from "express-validator";
import { assertValidRequest } from "../middleware/requestValidation";
import { StellarService } from "../services/stellar";
import { isValidAccountId } from "../validation/historyQuery";

/**
 * #60 — single transaction by hash, for the transaction detail screen and
 * shared links. Public, like the /account read routes: everything returned
 * is already public on-ledger data.
 */
export function createTransactionsRouter(stellar: StellarService): Router {
  const router = Router();

  router.get(
    "/:hash",
    param("hash")
      .matches(/^[0-9a-fA-F]{64}$/)
      .withMessage("hash must be a 64-character hex transaction hash"),
    query("account")
      .optional()
      .custom(isValidAccountId)
      .withMessage("account must be a valid G... address"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const detail = await stellar.getTransactionDetail(
          req.params.hash.toLowerCase(),
          req.query.account as string | undefined
        );
        res.json(detail);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
