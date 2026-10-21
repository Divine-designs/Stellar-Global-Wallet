import { NextFunction, Request, Response } from "express";

const SUNSET = new Date("2027-01-01T00:00:00.000Z");
const DEPRECATION_HEADER = `@${Math.floor(SUNSET.getTime() / 1000)}`;

export function deprecated(route: string, link = "/docs/client-signing") {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Deprecation", DEPRECATION_HEADER);
    res.setHeader("Sunset", SUNSET.toUTCString());
    res.setHeader("Link", `<${link}>; rel="deprecation"`);

    const requestId = res.getHeader("X-Request-Id") ?? req.header("X-Request-Id");
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "deprecated_route_called",
        route,
        requestId: typeof requestId === "string" ? requestId : null,
      })
    );
    next();
  };
}
