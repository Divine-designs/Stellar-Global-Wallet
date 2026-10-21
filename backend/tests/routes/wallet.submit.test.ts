import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createClientSigningRouter } from "../../src/routes/clientSigning";
import { StellarService } from "../../src/services/stellar";
import { appWithRouter, authHeader } from "../helpers/routerApp";
import { feeBumped, horizonRejection, signedPayment } from "../helpers/signedTx";

// In-memory stand-in for the Postgres-backed idempotency table.
jest.mock("../../src/services/idempotency", () => {
  const store = new Map<string, { hash: string; successful: boolean }>();
  return {
    getCachedResult: jest.fn(async (source: string, key: string) => store.get(`${source}:${key}`) ?? null),
    cacheResult: jest.fn(async (source: string, key: string, hash: string, successful: boolean) => {
      store.set(`${source}:${key}`, { hash, successful });
    }),
  };
});

const { Horizon } = StellarSdk;

describe("POST /api/v1/wallet/submit (issue #2)", () => {
  const app = appWithRouter("/api/v1/wallet", createClientSigningRouter(new StellarService()));
  const post = () => request(app).post("/api/v1/wallet/submit").set(authHeader());

  function mockSubmit(hash = "a".repeat(64)) {
    return jest
      .spyOn(Horizon.Server.prototype, "submitTransaction")
      .mockResolvedValue({ hash, ledger: 555, successful: true } as never);
  }

  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("rejects an unauthenticated request", async () => {
    await request(app).post("/api/v1/wallet/submit").send({ signedXdr: signedPayment().xdr }).expect(401);
  });

  it("submits a locally signed XDR and returns hash, ledger and successful", async () => {
    const submit = mockSubmit();

    const res = await post().send({ signedXdr: signedPayment().xdr }).expect(200);

    expect(res.body).toEqual({ hash: "a".repeat(64), ledger: 555, successful: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("accepts a fee-bump envelope", async () => {
    const bump = feeBumped(signedPayment().tx, StellarSdk.Keypair.random());
    mockSubmit(bump.hash);

    const res = await post().send({ signedXdr: bump.xdr }).expect(200);

    expect(res.body.hash).toBe(bump.hash);
  });

  it("rejects a secret key or any unknown field instead of ignoring it", async () => {
    const submit = mockSubmit();
    const secret = StellarSdk.Keypair.random().secret();

    const res = await post().send({ signedXdr: signedPayment().xdr, sourceSecretKey: secret }).expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: "sourceSecretKey" }));
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["empty", { signedXdr: "" }],
    ["not a string", { signedXdr: 42 }],
  ])("rejects a signedXdr that is %s", async (_label, payload) => {
    const res = await post().send(payload).expect(400);

    expect(res.body.error.details).toContainEqual(expect.objectContaining({ path: "signedXdr" }));
  });

  it.each([
    ["is not an XDR envelope", "AAAA", "MALFORMED_XDR"],
    ["is unsigned", signedPayment({ unsigned: true }).xdr, "UNSIGNED"],
    ["was signed for another network", signedPayment({ networkPassphrase: StellarSdk.Networks.PUBLIC }).xdr, "WRONG_NETWORK"],
  ])("returns 400 INVALID_TRANSACTION when the envelope %s", async (_label, signedXdr, reason) => {
    const submit = mockSubmit();

    const res = await post().send({ signedXdr }).expect(400);

    expect(res.body.error).toMatchObject({ code: "INVALID_TRANSACTION", details: { reason } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns TX_EXPIRED for expired time bounds", async () => {
    const submit = mockSubmit();
    const { xdr } = signedPayment({ maxTime: Math.floor(Date.now() / 1000) - 1 });

    const res = await post().send({ signedXdr: xdr }).expect(400);

    expect(res.body.error.code).toBe("TX_EXPIRED");
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns 202 with the hash and a pending status when Horizon times out", async () => {
    const { xdr, hash } = signedPayment();
    jest
      .spyOn(Horizon.Server.prototype, "submitTransaction")
      .mockRejectedValue(Object.assign(new Error("Gateway Timeout"), { response: { status: 504 } }));

    const res = await post().send({ signedXdr: xdr }).expect(202);

    expect(res.body).toEqual({ hash, status: "pending" });
  });

  it("returns TX_ALREADY_SUBMITTED with the hash when the same XDR is sent again without a key", async () => {
    const { xdr, hash } = signedPayment();
    jest.spyOn(Horizon.Server.prototype, "submitTransaction").mockRejectedValue(horizonRejection({ transaction: "tx_bad_seq" }));
    jest.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({
      transaction: () => ({ call: async () => ({}) }),
    } as never);

    const res = await post().send({ signedXdr: xdr }).expect(409);

    expect(res.body.error).toMatchObject({ code: "TX_ALREADY_SUBMITTED", details: { hash } });
  });

  describe("idempotency", () => {
    it("returns the first result for a repeated Idempotency-Key header and submits only once", async () => {
      const submit = mockSubmit("b".repeat(64));
      const { xdr } = signedPayment();

      const first = await post().set("Idempotency-Key", "key-header-1").send({ signedXdr: xdr }).expect(200);
      const second = await post().set("Idempotency-Key", "key-header-1").send({ signedXdr: xdr }).expect(200);

      expect(first.body).toEqual({ hash: "b".repeat(64), ledger: 555, successful: true });
      expect(second.body).toEqual({ hash: "b".repeat(64), successful: true });
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("honours the idempotencyKey body field the same way", async () => {
      const submit = mockSubmit("c".repeat(64));
      const { xdr } = signedPayment();

      await post().send({ signedXdr: xdr, idempotencyKey: "key-body-1" }).expect(200);
      const second = await post().send({ signedXdr: xdr, idempotencyKey: "key-body-1" }).expect(200);

      expect(second.body.hash).toBe("c".repeat(64));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("replays the first result even after the envelope's time bounds have passed", async () => {
      const keypair = StellarSdk.Keypair.random();
      const submit = mockSubmit("d".repeat(64));
      const nowSeconds = Math.floor(Date.now() / 1000);
      const { xdr } = signedPayment({ keypair, maxTime: nowSeconds + 1 });
      await post().set("Idempotency-Key", "key-late-1").send({ signedXdr: xdr }).expect(200);

      jest.spyOn(Date, "now").mockReturnValue((nowSeconds + 60) * 1000);
      const replay = await post().set("Idempotency-Key", "key-late-1").send({ signedXdr: xdr }).expect(200);

      expect(replay.body.hash).toBe("d".repeat(64));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("submits again for a different key from the same account", async () => {
      const keypair = StellarSdk.Keypair.random();
      const submit = mockSubmit();

      await post().set("Idempotency-Key", "k-a").send({ signedXdr: signedPayment({ keypair }).xdr }).expect(200);
      await post().set("Idempotency-Key", "k-b").send({ signedXdr: signedPayment({ keypair }).xdr }).expect(200);

      expect(submit).toHaveBeenCalledTimes(2);
    });

    it("does not cache a failed submission", async () => {
      const { xdr } = signedPayment();
      jest
        .spyOn(Horizon.Server.prototype, "submitTransaction")
        .mockRejectedValueOnce(horizonRejection({ transaction: "tx_failed", operations: ["op_underfunded"] }))
        .mockResolvedValueOnce({ hash: "e".repeat(64), ledger: 1, successful: true } as never);

      await post().set("Idempotency-Key", "key-fail-1").send({ signedXdr: xdr }).expect(400);
      const retry = await post().set("Idempotency-Key", "key-fail-1").send({ signedXdr: xdr }).expect(200);

      expect(retry.body.hash).toBe("e".repeat(64));
    });
  });
});
