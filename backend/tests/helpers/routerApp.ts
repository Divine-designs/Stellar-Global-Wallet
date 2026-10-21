import express, { Router } from "express";
import { errorHandler } from "../../src/middleware/errorHandler";
import { generateAccessToken } from "../../src/utils/jwt";

/**
 * Mounts a single router behind the real error handler, so route tests
 * exercise the router's validation, auth and error mapping without booting
 * the whole app (and its database/Redis wiring).
 */
export function appWithRouter(mountPath: string, router: Router) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  app.use(errorHandler);
  return app;
}

export function authHeader() {
  return { Authorization: `Bearer ${generateAccessToken("test-user")}` };
}
