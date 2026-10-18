import { Router } from "express";
import { body } from "express-validator";
import { rateLimit } from "express-rate-limit";
import { AppError, UnauthorizedError } from "../errors/appError";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { assertValidRequest } from "../middleware/requestValidation";
import {
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from "../utils/jwt";

export const authRouter = Router();

// Dedicated, tighter rate limit for this route specifically (issue #91).
// /auth/login is the one endpoint that authenticates directly against the
// shared API_KEY secret, so it's the highest-value credential-guessing
// target in the API — the generous global limiter in app.ts (100 req /
// 15 min, shared across every route including /health) is not calibrated
// to that. This budget applies independently, on top of the global one.
//
// The handler routes through errorHandler (issue #22) so the response uses
// the shared error envelope instead of express-rate-limit's default body.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(
      new AppError("Too many login attempts, please try again later", {
        code: "RATE_LIMITED",
        status: 429,
        retryable: true,
      })
    );
  },
});

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
