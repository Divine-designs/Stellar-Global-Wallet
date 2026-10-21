import { NextFunction, Request, Response } from "express";
import { validationResult } from "express-validator";
import { ValidationError, ValidationIssue } from "../errors/appError";

type ValidationResultIssue = {
  location?: string;
  msg: unknown;
  path?: string;
  type?: string;
  value?: unknown;
};

export function assertValidRequest(req: Request) {
  const result = validationResult(req);
  if (result.isEmpty()) {
    return;
  }

  const issues: ValidationIssue[] = (result.array() as ValidationResultIssue[]).map((issue) => ({
    location: issue.location,
    message: String(issue.msg),
    path: issue.path,
    type: issue.type,
    value: issue.value,
  }));

  throw new ValidationError(issues);
}

const SECRET_FIELD_PATTERN = /secret|seed|mnemonic|private/i;

/**
 * Deny-by-default body check for the non-custodial build/submit endpoints:
 * a field outside `allowed` is rejected rather than ignored, so a client
 * that still sends `sourceSecretKey` is told so instead of quietly handing a
 * secret to a server that never needed it. Offending values are never echoed
 * back in the response.
 */
export function rejectUnknownBodyFields(allowed: readonly string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const unknown = Object.keys(req.body ?? {}).filter((key) => !allowed.includes(key));
    if (unknown.length === 0) {
      next();
      return;
    }
    next(
      new ValidationError(
        unknown.map((key) => ({
          location: "body",
          path: key,
          message: SECRET_FIELD_PATTERN.test(key)
            ? "Secret keys are never accepted by this endpoint; sign the returned XDR client-side"
            : "Unknown field",
        }))
      )
    );
  };
}
