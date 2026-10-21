const query = jest.fn();
jest.mock("../../src/db", () => ({ pool: { query: (...args: unknown[]) => query(...args) } }));

import { cacheResult, getCachedResult } from "../../src/services/idempotency";

describe("idempotency cache", () => {
  beforeEach(() => query.mockReset());

  it("only reads results younger than 24 hours", async () => {
    query.mockResolvedValue({ rows: [{ result_hash: "abc", result_successful: true }] });

    const cached = await getCachedResult("GSOURCE", "key-1");

    expect(cached).toEqual({ hash: "abc", successful: true });
    expect(query.mock.calls[0][0]).toMatch(/created_at > NOW\(\) - INTERVAL '24 hours'/);
    expect(query.mock.calls[0][1]).toEqual(["GSOURCE", "key-1"]);
  });

  it("returns null when nothing is cached", async () => {
    query.mockResolvedValue({ rows: [] });

    expect(await getCachedResult("GSOURCE", "key-1")).toBeNull();
  });

  it("keeps a live entry but lets a result older than 24 hours be overwritten", async () => {
    query.mockResolvedValue({ rows: [] });

    await cacheResult("GSOURCE", "key-1", "abc", true);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/ON CONFLICT \(source_public_key, idempotency_key\) DO UPDATE/);
    expect(sql).toMatch(/WHERE idempotency_keys\.created_at <= NOW\(\) - INTERVAL '24 hours'/);
    expect(query.mock.calls[0][1]).toEqual(["GSOURCE", "key-1", "abc", true]);
  });
});
