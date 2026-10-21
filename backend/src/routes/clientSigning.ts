import { Router } from "express";
import { body } from "express-validator";
import { jwtAuth } from "../middleware/jwtAuth";
import { assertValidRequest, rejectUnknownBodyFields } from "../middleware/requestValidation";
import { StellarService } from "../services/stellar";
import { publicKeyMessage } from "../utils/stellarAddress";
import {
  assetParamMessage,
  destinationOrMuxedMessage,
  isValidAssetParam,
  isValidDestination,
} from "../validation/buildRequest";
import { isValidAccountId } from "../validation/historyQuery";
import { amountMessage, isValidMemoText, isValidStellarAmount, memoTextMessage } from "@globe-wallet/sdk";

/**
 * Non-custodial wallet endpoints (docs/client-signing.md): the server builds
 * an unsigned transaction, the client signs it with its own wallet, and the
 * server submits the signed envelope. None of these routes accepts a secret
 * key — `rejectUnknownBodyFields` turns one away with a 400.
 *
 * Kept in its own router, mounted by `createWalletRouter`, so these routes
 * can be exercised without the rest of the wallet router. Each route gates
 * itself with `jwtAuth` for the same reason.
 */
export function createClientSigningRouter(stellar: StellarService): Router {
  const router = Router();

  // #1 — unsigned payment XDR for the client to sign (Freighter, xBull, a
  // local key, ...).
  router.post(
    "/send/build",
    jwtAuth,
    rejectUnknownBodyFields(["sourcePublicKey", "destinationPublicKey", "amount", "asset", "memo"]),
    body("sourcePublicKey").custom(isValidAccountId).withMessage(publicKeyMessage),
    body("destinationPublicKey").custom(isValidDestination).withMessage(destinationOrMuxedMessage),
    body("amount").custom(isValidStellarAmount).withMessage(amountMessage),
    body("asset").optional().custom(isValidAssetParam).withMessage(assetParamMessage),
    body("memo").optional().isString().custom(isValidMemoText).withMessage(memoTextMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { sourcePublicKey, destinationPublicKey, amount, asset, memo } = req.body;
        res.json(await stellar.buildPayment({ sourcePublicKey, destinationPublicKey, amount, asset, memo }));
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
