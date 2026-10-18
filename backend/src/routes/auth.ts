import { Router } from "express";
import { body, query } from "express-validator";
import { rateLimit } from "express-rate-limit";
import { Keypair, Networks, Transaction, Utils } from "@stellar/stellar-sdk";
import { UnauthorizedError, BadRequestError } from "../errors/appError";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { assertValidRequest } from "../middleware/requestValidation";
import {
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from "../utils/jwt";
import { config } from "../config";

export const authRouter = Router();

// Dedicated, tighter rate limit for this route specifically (issue #91).
// /auth/login is the one endpoint that authenticates directly against the
// shared API_KEY secret, so it's the highest-value credential-guessing
// target in the API — the generous global limiter in app.ts (100 req /
// 15 min, shared across every route including /health) is not calibrated
// to that. This budget applies independently, on top of the global one.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later", code: "LOGIN_RATE_LIMITED" },
});

// SEP-10 challenge lifetime in seconds.
const CHALLENGE_TTL_SECONDS = 300;

const networkPassphrase =
  config.STELLAR_NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET;

function getServerKeypair(): Keypair {
  return Keypair.fromSecret(config.SEP10_SIGNING_SECRET);
}

authRouter.post(
  "/login",
  loginLimiter,
  apiKeyAuth,
  async (_req, res, next) => {
    try {
      // We currently use a single shared API key model.
      // This fixed 'sub' explicitly documents that all traffic shares
      // a single identity, rather than implying per-caller signal.
      // See #88 and this identity decision for context.
      const sub = "api-key-user";
      const accessToken = generateAccessToken(sub);
      const refreshToken = await generateRefreshToken(sub);
      res.json({ accessToken, refreshToken, tokenType: "Bearer" });
    } catch (err) {
      next(err);
    }
  }
);

// SEP-10: build a challenge transaction the wallet must sign.
authRouter.get(
  "/challenge",
  query("account").isString().notEmpty(),
  async (req, res, next) => {
    try {
      assertValidRequest(req);
      const account = String(req.query.account);
      if (!Keypair.isValidPublicKey(account)) {
        throw new BadRequestError("Invalid Stellar account", "INVALID_ACCOUNT");
      }
      const challenge = Utils.buildChallengeTx(
        getServerKeypair(),
        account,
        config.HOME_DOMAIN,
        CHALLENGE_TTL_SECONDS,
        networkPassphrase,
        config.WEB_AUTH_DOMAIN
      );
      res.json({ transaction: challenge, networkPassphrase });
    } catch (err) {
      next(err);
    }
  }
);

// SEP-10: verify the signed challenge and issue per-user JWTs.
authRouter.post(
  "/token",
  body("transaction").isString().notEmpty(),
  async (req, res, next) => {
    try {
      assertValidRequest(req);
      const serverKeypair = getServerKeypair();
      const { tx, clientAccountID } = Utils.readChallengeTx(
        req.body.transaction,
        serverKeypair.publicKey(),
        networkPassphrase,
        config.HOME_DOMAIN,
        config.WEB_AUTH_DOMAIN
      );

      // Verify the challenge is signed by the client account. For unfunded
      // accounts the master key is the only signer; funded accounts may be
      // multisig, so we check signers/thresholds against Horizon.
      const signers = await loadAccountSigners(clientAccountID);
      if (signers) {
        Utils.verifyChallengeTxThreshold(
          tx,
          serverKeypair.publicKey(),
          networkPassphrase,
          config.HOME_DOMAIN,
          config.WEB_AUTH_DOMAIN,
          signers.threshold,
          signers.signers
        );
      } else {
        Utils.verifyChallengeTxSigners(
          tx,
          serverKeypair.publicKey(),
          networkPassphrase,
          config.HOME_DOMAIN,
          config.WEB_AUTH_DOMAIN,
          [clientAccountID]
        );
      }

      const sub = clientAccountID;
      const accessToken = generateAccessToken(sub);
      const refreshToken = await generateRefreshToken(sub);
      res.json({
        accessToken,
        refreshToken,
        tokenType: "Bearer",
        account: sub,
        auth_method: "sep10",
      });
    } catch (err) {
      next(err);
    }
  }
);

interface AccountSigners {
  threshold: number;
  signers: { key: string; weight: number }[];
}

// Load signers from Horizon. Returns null for unfunded accounts (404),
// in which case the caller falls back to master-key verification.
async function loadAccountSigners(account: string): Promise<AccountSigners | null> {
  const url = `${config.HORIZON_URL.replace(/\/$/, "")}/accounts/${account}`;
  const response = await fetch(url);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new UnauthorizedError("Unable to load account signers", "SIGNER_LOOKUP_FAILED");
  }
  const data = (await response.json()) as {
    thresholds?: { med_threshold?: number };
    signers?: { key: string; weight: number }[];
  };
  return {
    threshold: data.thresholds?.med_threshold ?? 0,
    signers: data.signers ?? [],
  };
}

authRouter.post(
  "/refresh",
  body("refreshToken").isString().notEmpty(),
  async (req, res, next) => {
    try {
      assertValidRequest(req);
      const result = await rotateRefreshToken(req.body.refreshToken);
      if (!result) {
        throw new UnauthorizedError(
          "Invalid, expired, or revoked refresh token",
          "REFRESH_TOKEN_INVALID"
        );
      }
      res.json({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        tokenType: "Bearer",
      });
    } catch (err) {
      next(err);
    }
  }
);

authRouter.post(
  "/logout",
  body("refreshToken").isString().notEmpty(),
  async (req, res, next) => {
    try {
      assertValidRequest(req);
      await revokeRefreshToken(req.body.refreshToken);
      res.json({ message: "Logged out" });
    } catch (err) {
      next(err);
    }
  }
);
