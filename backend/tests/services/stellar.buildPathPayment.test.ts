import * as StellarSdk from "@stellar/stellar-sdk";
import { StellarService } from "../../src/services/stellar";
import { ValidationError } from "../../src/errors/appError";
import {
  DestinationNotFundedError,
  DestinationTrustlineError,
  MemoRequiredError,
  SourceAccountNotFoundError,
} from "../../src/services/stellarErrors";

const { Horizon } = StellarSdk;
const PASSPHRASE = process.env.NETWORK_PASSPHRASE as string;

const source = StellarSdk.Keypair.random().publicKey();
const destination = StellarSdk.Keypair.random().publicKey();
const issuer = StellarSdk.Keypair.random().publicKey();
const usdc = `USDC:${issuer}`;
const hop1 = `BTCN:${StellarSdk.Keypair.random().publicKey()}`;
const hop2 = `EURT:${StellarSdk.Keypair.random().publicKey()}`;

function account(publicKey: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new StellarSdk.Account(publicKey, "100"), extra) as unknown as StellarSdk.Horizon.AccountResponse;
}

function usdcTrustline(extra: Record<string, unknown> = {}) {
  return { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "0.0000000", ...extra };
}

/** Source and destination exist; the destination trusts USDC unless `destinationExtra` says otherwise. */
function mockAccounts(destinationExtra: Record<string, unknown> = { balances: [usdcTrustline()] }, sourceExists = true) {
  jest.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(100);
  return jest.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => {
    if (id === source && sourceExists) return account(source);
    if (id === destination) return account(destination, destinationExtra);
    throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
  });
}

function decode(xdr: string) {
  return StellarSdk.TransactionBuilder.fromXDR(xdr, PASSPHRASE) as StellarSdk.Transaction;
}

const strictSend = {
  sourcePublicKey: source,
  destinationPublicKey: destination,
  sendAmount: "100",
  destAsset: usdc,
  quotedDestAmount: "20",
};

const strictReceive = {
  sourcePublicKey: source,
  destinationPublicKey: destination,
  destAsset: usdc,
  destAmount: "20",
  quotedSendAmount: "100",
};

describe("StellarService path payment builders (issue #3)", () => {
  afterEach(() => jest.restoreAllMocks());

  describe("buildPathPaymentStrictSend", () => {
    it("returns an unsigned strict-send operation with destMin derived from the default 50 bps slippage", async () => {
      mockAccounts();

      const built = await new StellarService().buildPathPaymentStrictSend({ ...strictSend, path: [hop1, hop2] });

      const tx = decode(built.xdr);
      expect(tx.signatures).toHaveLength(0);
      expect(tx.operations).toHaveLength(1);
      const op = tx.operations[0] as StellarSdk.Operation.PathPaymentStrictSend;
      expect(op).toMatchObject({ type: "pathPaymentStrictSend", destination, sendAmount: "100.0000000", destMin: "19.9000000" });
      expect(op.sendAsset.isNative()).toBe(true);
      expect(op.destAsset.getCode()).toBe("USDC");
      expect(op.path.map((a) => a.getCode())).toEqual(["BTCN", "EURT"]);

      expect(built).toMatchObject({
        networkPassphrase: PASSPHRASE,
        expectedSend: "100.0000000",
        expectedReceive: "20.0000000",
        minReceive: "19.9000000",
        slippageBps: 50,
        path: [hop1, hop2],
      });
      expect(built.sequence).toBe("101");
    });

    it("honours an explicit slippage tolerance and send asset", async () => {
      mockAccounts();

      const built = await new StellarService().buildPathPaymentStrictSend({
        ...strictSend,
        sendAsset: hop1,
        slippageBps: 500,
      });

      const op = decode(built.xdr).operations[0] as StellarSdk.Operation.PathPaymentStrictSend;
      expect(op.destMin).toBe("19.0000000");
      expect(op.sendAsset.getCode()).toBe("BTCN");
      expect(built.slippageBps).toBe(500);
    });

    it("rounds destMin down at the 7-decimal boundary", async () => {
      mockAccounts();

      const built = await new StellarService().buildPathPaymentStrictSend({
        ...strictSend,
        quotedDestAmount: "0.0000003",
      });

      expect(built.minReceive).toBe("0.0000002");
    });

    it("builds a direct trade when the path is empty or omitted", async () => {
      mockAccounts();
      const stellar = new StellarService();

      for (const path of [undefined, []]) {
        const built = await stellar.buildPathPaymentStrictSend({ ...strictSend, path });
        expect((decode(built.xdr).operations[0] as StellarSdk.Operation.PathPaymentStrictSend).path).toEqual([]);
        expect(built.path).toEqual([]);
      }
    });

    it("rejects a path with more than five assets or a malformed asset", async () => {
      mockAccounts();
      const stellar = new StellarService();

      await expect(
        stellar.buildPathPaymentStrictSend({ ...strictSend, path: Array(6).fill(hop1) })
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        stellar.buildPathPaymentStrictSend({ ...strictSend, path: ["USDC-no-issuer"] })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("does not need a trustline for XLM and encodes a memo", async () => {
      mockAccounts({ balances: [] });

      const built = await new StellarService().buildPathPaymentStrictSend({
        ...strictSend,
        destAsset: "XLM",
        memo: "swap-1",
      });

      expect(decode(built.xdr).memo.value?.toString()).toBe("swap-1");
    });
  });

  describe("buildPathPaymentStrictReceive", () => {
    it("returns an unsigned strict-receive operation with sendMax derived from the default 50 bps slippage", async () => {
      mockAccounts();

      const built = await new StellarService().buildPathPaymentStrictReceive({ ...strictReceive, path: [hop1] });

      const tx = decode(built.xdr);
      expect(tx.signatures).toHaveLength(0);
      const op = tx.operations[0] as StellarSdk.Operation.PathPaymentStrictReceive;
      expect(op).toMatchObject({
        type: "pathPaymentStrictReceive",
        destination,
        destAmount: "20.0000000",
        sendMax: "100.5000000",
      });
      expect(op.destAsset.getCode()).toBe("USDC");
      expect(op.path.map((a) => a.getCode())).toEqual(["BTCN"]);

      expect(built).toMatchObject({
        expectedSend: "100.0000000",
        expectedReceive: "20.0000000",
        maxSend: "100.5000000",
        slippageBps: 50,
        path: [hop1],
      });
    });

    it("rounds sendMax up at the 7-decimal boundary", async () => {
      mockAccounts();

      const built = await new StellarService().buildPathPaymentStrictReceive({
        ...strictReceive,
        quotedSendAmount: "0.0000003",
      });

      expect(built.maxSend).toBe("0.0000004");
    });

    it("builds a direct trade with an empty path", async () => {
      mockAccounts();

      const built = await new StellarService().buildPathPaymentStrictReceive({ ...strictReceive, path: [] });

      expect((decode(built.xdr).operations[0] as StellarSdk.Operation.PathPaymentStrictReceive).path).toEqual([]);
    });
  });

  describe.each([
    ["strict-send", (s: StellarService, extra = {}) => s.buildPathPaymentStrictSend({ ...strictSend, ...extra })],
    ["strict-receive", (s: StellarService, extra = {}) => s.buildPathPaymentStrictReceive({ ...strictReceive, ...extra })],
  ])("%s pre-checks", (_name, build) => {
    it("rejects a destination without a trustline for the destination asset", async () => {
      mockAccounts({ balances: [] });

      const promise = build(new StellarService());

      await expect(promise).rejects.toBeInstanceOf(DestinationTrustlineError);
      await expect(promise).rejects.toMatchObject({
        code: "DESTINATION_NO_TRUSTLINE",
        status: 400,
        details: { reason: "NO_TRUSTLINE", destination, asset: usdc },
      });
    });

    it("rejects a trustline the issuer has not authorized", async () => {
      mockAccounts({ balances: [usdcTrustline({ is_authorized: false })] });

      await expect(build(new StellarService())).rejects.toMatchObject({
        code: "DESTINATION_NO_TRUSTLINE",
        details: { reason: "TRUSTLINE_NOT_AUTHORIZED" },
      });
    });

    it("lets the issuer receive its own asset without a trustline", async () => {
      jest.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(100);
      jest.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => {
        if (id === source || id === issuer) return account(id, { balances: [] });
        throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
      });

      await expect(build(new StellarService(), { destinationPublicKey: issuer })).resolves.toMatchObject({
        networkPassphrase: PASSPHRASE,
      });
    });

    it("rejects a destination that does not exist, because a path payment cannot create it", async () => {
      jest.spyOn(Horizon.Server.prototype, "fetchBaseFee").mockResolvedValue(100);
      jest.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (id: string) => {
        if (id === source) return account(source);
        throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
      });

      const promise = build(new StellarService());

      await expect(promise).rejects.toBeInstanceOf(DestinationNotFundedError);
      await expect(promise).rejects.toMatchObject({ code: "DESTINATION_NOT_FUNDED", status: 400 });
    });

    it("enforces SEP-29 memo requirements", async () => {
      mockAccounts({ balances: [usdcTrustline()], data_attr: { "config.memo_required": "MQ==" } });

      await expect(build(new StellarService())).rejects.toBeInstanceOf(MemoRequiredError);
      await expect(build(new StellarService(), { memo: "dep-9" })).resolves.toBeDefined();
    });

    it("throws SOURCE_ACCOUNT_NOT_FOUND for an unfunded source", async () => {
      mockAccounts(undefined, false);

      await expect(build(new StellarService())).rejects.toBeInstanceOf(SourceAccountNotFoundError);
    });

    it("runs destination checks against the base account of a muxed destination", async () => {
      const muxed = new StellarSdk.MuxedAccount(new StellarSdk.Account(destination, "0"), "7").accountId();
      mockAccounts();

      const built = await build(new StellarService(), { destinationPublicKey: muxed });

      expect((decode(built.xdr).operations[0] as { destination: string }).destination).toBe(muxed);
    });
  });
});
