import express from "express";
import request from "supertest";
import { deprecated } from "../../src/middleware/deprecated";

describe("deprecated route middleware", () => {
  it("adds RFC deprecation headers and logs the route with its request ID", async () => {
    const app = express();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    app.post("/legacy", deprecated("POST /legacy"), (_req, res) => res.sendStatus(204));

    try {
      const res = await request(app)
        .post("/legacy")
        .set("X-Request-Id", "req-12345678")
        .expect(204);

      expect(res.headers.deprecation).toBe("@1798761600");
      expect(res.headers.sunset).toBe("Fri, 01 Jan 2027 00:00:00 GMT");
      expect(res.headers.link).toBe('</docs/client-signing>; rel="deprecation"');
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          level: "warn",
          event: "deprecated_route_called",
          route: "POST /legacy",
          requestId: "req-12345678",
        })
      );
    } finally {
      warn.mockRestore();
    }
  });
});
