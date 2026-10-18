import { Request, Response, NextFunction } from "express";
import { UnauthorizedError } from "../errors/appError";

/**
 * Deprecated `x-api-key` authentication has been removed.
 *
 * This middleware is retained only as a deny-by-default guard so that any
 * route still wired to it rejects requests instead of silently passing
 * through. Clients must authenticate with Bearer tokens obtained from
 * POST /api/v1/auth/login.
 */
export function apiKeyAuth(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Deprecated", "apiKeyAuth removed - use JWT auth via /api/v1/auth/login");
  next(new UnauthorizedError("Unauthorized", "API_KEY_UNAUTHORIZED"));
}
