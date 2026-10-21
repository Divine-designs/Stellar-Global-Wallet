import { Router } from "express";
import { body, param } from "express-validator";
import { assertValidRequest, rejectUnknownBodyFields } from "../middleware/requestValidation";
import { GlobeWalletContract } from "../services/contracts/globeWallet";
import { jwtAuth } from "../middleware/jwtAuth";
import { deprecated } from "../middleware/deprecated";
import { isGAddress, publicKeyMessage } from "../utils/stellarAddress";
import { isValidAccountId } from "../validation/historyQuery";

/** Largest value a Soroban i128 can hold. */
const I128_MAX = 2n ** 127n - 1n;

/** Positive integer stroop amount that fits an i128 — checked as BigInt so it never loses precision. */
function isValidSpendAmount(value: unknown): boolean {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) && BigInt(value) <= I128_MAX;
}

export function createContractRouter(globeWallet: GlobeWalletContract): Router {
  const contractRouter = Router();

  contractRouter.get(
    "/wallet/:publicKey/assets",
    param("publicKey")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const assets = await globeWallet.getAssets(req.params.publicKey);
        res.json({ assets });
      } catch (err) {
        next(err);
      }
    }
  );

  // #50 — "X of Y left today": limit, spent and remaining per whitelisted asset.
  contractRouter.get(
    "/wallet/:publicKey/spend-allowance",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const allowances = await globeWallet.getSpendAllowances(req.params.publicKey);
        res.json({ allowances });
      } catch (err) {
        next(err);
      }
    }
  );

  // #50 — same, for one asset code (need not be on the whitelist).
  contractRouter.get(
    "/wallet/:publicKey/spend-allowance/:assetCode",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    param("assetCode")
      .matches(/^[A-Za-z0-9]{1,12}$/)
      .withMessage("must be a 1-12 character alphanumeric asset code"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const allowance = await globeWallet.getSpendAllowance(req.params.publicKey, req.params.assetCode);
        res.json(allowance);
      } catch (err) {
        next(err);
      }
    }
  );

  // #51 — guardian set (empty array when none registered).
  contractRouter.get("/wallet/guardians", async (_req, res, next) => {
    try {
      const guardians = await globeWallet.getGuardians();
      res.json({ guardians });
    } catch (err) {
      next(err);
    }
  });

  // #51 — recovery threshold + timelock; `config: null` when not configured.
  contractRouter.get("/wallet/recovery/config", async (_req, res, next) => {
    try {
      const config = await globeWallet.getRecoveryConfig();
      res.json({ config });
    } catch (err) {
      next(err);
    }
  });

  // #51 — active proposal with approvals vs threshold and ETA; `proposal: null` when none.
  contractRouter.get("/wallet/recovery/proposal", async (_req, res, next) => {
    try {
      const proposal = await globeWallet.getRecoveryProposal();
      res.json({ proposal });
    } catch (err) {
      next(err);
    }
  });

  // #51 — convenience: guardians + config + proposal in one response.
  contractRouter.get("/wallet/recovery", async (_req, res, next) => {
    try {
      const state = await globeWallet.getRecoveryState();
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  // #80 — Settings screen: read current admin and pending admin candidate (null-safe)
  contractRouter.get("/admin", async (_req, res, next) => {
    try {
      const state = await globeWallet.getAdminState();
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  // #81 — Transparency: expose contract upgrade timelock state (null-safe)
  contractRouter.get("/upgrade", async (_req, res, next) => {
    try {
      const pendingUpgrade = await globeWallet.getPendingUpgrade();
      res.json({ pendingUpgrade });
    } catch (err) {
      next(err);
    }
  });

  contractRouter.use("/wallet/spend", (req, res, next) => {
    if (req.method === "POST") {
      return deprecated("POST /api/v1/contract/wallet/spend")(req, res, next);
    }
    return next();
  });

  contractRouter.use(jwtAuth);

  // #8 — build unsigned XDR for the wallet's asset registry.
  contractRouter.post(
    "/wallet/assets/build",
    body().custom((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return Object.keys(value).every((key) => key === "user" || key === "asset");
    }),
    body("user")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("asset")
      .isObject()
      .custom((asset: unknown) => {
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) return false;
        const value = asset as Record<string, unknown>;
        return (
          Object.keys(value).every((key) => key === "code" || key === "issuer") &&
          typeof value.code === "string" &&
          /^[A-Za-z0-9]{1,12}$/.test(value.code) &&
          ((value.code === "XLM" && value.issuer === null) ||
            (value.code !== "XLM" &&
              typeof value.issuer === "string" &&
              isGAddress(value.issuer)))
        );
      })
      .withMessage("asset must contain a 1-12 character code and a valid issuer (null for XLM)"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const xdr = await globeWallet.buildAddAssetTx({
          user: req.body.user,
          asset: req.body.asset,
        });
        res.json({ xdr });
      } catch (err) {
        next(err);
      }
    }
  );

  // #8 — build unsigned XDR for removing an asset from the wallet registry.
  contractRouter.post(
    "/wallet/assets/remove/build",
    body().custom((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return Object.keys(value).every((key) => key === "user" || key === "assetCode");
    }),
    body("user")
      .isLength({ min: 56, max: 56 })
      .bail()
      .custom(isGAddress)
      .withMessage(publicKeyMessage),
    body("assetCode").matches(/^[A-Za-z0-9]{1,12}$/),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const xdr = await globeWallet.buildRemoveAssetTx({
          user: req.body.user,
          assetCode: req.body.assetCode,
        });
        res.json({ xdr });
      } catch (err) {
        next(err);
      }
    }
  );

  // #80 — Build unsigned transaction XDR for admin propose
  contractRouter.post(
    "/admin/propose",
    body("currentAdmin").custom(isGAddress).withMessage(publicKeyMessage),
    body("candidate").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { currentAdmin, candidate } = req.body;
        const xdr = await globeWallet.buildProposeAdminTx({ currentAdmin, candidate });
        res.json({ xdr });
      } catch (err) {
        next(err);
      }
    }
  );

  // #80 — Build unsigned transaction XDR for admin accept
  contractRouter.post(
    "/admin/accept",
    body("candidate").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { candidate } = req.body;
        const xdr = await globeWallet.buildAcceptAdminTx({ candidate });
        res.json({ xdr });
      } catch (err) {
        next(err);
      }
    }
  );

  // #80 — Build unsigned transaction XDR for admin transfer cancel
  contractRouter.post(
    "/admin/cancel",
    body("currentAdmin").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { currentAdmin } = req.body;
        const xdr = await globeWallet.buildCancelAdminTransferTx({ currentAdmin });
        res.json({ xdr });
      } catch (err) {
        next(err);
      }
    }
  );

  contractRouter.post(
    "/wallet/spend",
    body("userSecretKey").isLength({ min: 56, max: 56 }),
    body("assetCode").isString().isLength({ min: 1, max: 12 }),
    body("amount").isNumeric(),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { userSecretKey, assetCode, amount } = req.body;
        const result = await globeWallet.recordSpend({ userSecretKey, assetCode, amount });
        res.json({ hash: result.hash, ledger: result.ledger, successful: true });
      } catch (err) {
        next(err);
      }
    }
  );

  // #4 — non-custodial record_spend: simulates the call and returns the
  // assembled XDR (footprint, resource fee, auth entries) for the user to
  // sign, instead of taking `userSecretKey` like POST /wallet/spend.
  contractRouter.post(
    "/wallet/spend/build",
    rejectUnknownBodyFields(["userPublicKey", "assetCode", "amount"]),
    body("userPublicKey").custom(isValidAccountId).withMessage(publicKeyMessage),
    body("assetCode")
      .isString()
      .matches(/^[A-Za-z0-9]{1,12}$/)
      .withMessage("must be a 1-12 character alphanumeric asset code"),
    body("amount")
      .custom(isValidSpendAmount)
      .withMessage("amount must be a positive integer string in the asset's smallest unit (stroops)"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { userPublicKey, assetCode, amount } = req.body;
        res.json(await globeWallet.buildRecordSpend({ userPublicKey, assetCode, amount }));
      } catch (err) {
        next(err);
      }
    }
  );

  // #4 — submit the signed XDR from any contract build route and wait for the
  // final status. 202 with the hash if the network hasn't decided in time.
  contractRouter.post(
    "/wallet/submit",
    rejectUnknownBodyFields(["signedXdr"]),
    body("signedXdr").isString().isLength({ min: 1, max: 64 * 1024 }),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const result = await globeWallet.submitSigned(req.body.signedXdr);
        res.status("status" in result ? 202 : 200).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return contractRouter;
}
