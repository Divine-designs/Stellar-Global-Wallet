import {
  DEFAULT_SLIPPAGE_BPS,
  isValidSlippageBps,
  MAX_SLIPPAGE_BPS,
  maxSendAfterSlippage,
  minReceiveAfterSlippage,
} from "../../src/utils/slippage";

describe("minReceiveAfterSlippage (strict-send destMin, rounded down)", () => {
  it.each([
    ["50 bps off a round amount", "100", 50, "99.5000000"],
    ["0 bps leaves the quote untouched", "100", 0, "100.0000000"],
    ["the 500 bps maximum", "1", 500, "0.9500000"],
    ["a fractional quote that divides exactly", "0.1", 50, "0.0995000"],
    ["rounds down at the 7th decimal (2.985 stroops -> 2)", "0.0000003", 50, "0.0000002"],
    ["rounds down when only the last stroop is lost", "10.0000001", 1, "9.9990000"],
    ["floors a quote that would round to zero at one stroop, since destMin cannot be 0", "0.0000001", 50, "0.0000001"],
    ["stays exact for amounts past 2^53 stroops", "922337203685.4775807", 50, "917725517667.0501927"],
  ])("%s", (_label, quoted, bps, expected) => {
    expect(minReceiveAfterSlippage(quoted, bps)).toBe(expected);
  });

  it("never returns more than the quote", () => {
    for (const quoted of ["0.0000001", "0.0000009", "1.2345678", "99999.9999999"]) {
      for (const bps of [0, 1, 50, 499, 500]) {
        const min = minReceiveAfterSlippage(quoted, bps);
        expect(Number(min)).toBeLessThanOrEqual(Number(quoted));
      }
    }
  });
});

describe("maxSendAfterSlippage (strict-receive sendMax, rounded up)", () => {
  it.each([
    ["50 bps on a round amount", "100", 50, "100.5000000"],
    ["0 bps leaves the quote untouched", "100", 0, "100.0000000"],
    ["a fractional quote that divides exactly", "0.1", 500, "0.1050000"],
    ["does not round up when the result is exact (201 stroops)", "0.0000200", 50, "0.0000201"],
    ["rounds up at the 7th decimal (3.015 stroops -> 4)", "0.0000003", 50, "0.0000004"],
    ["rounds up when only the last stroop is gained", "1.0000001", 1, "1.0001002"],
    ["stays exact for amounts past 2^53 stroops", "922337203685.4775807", 50, "926948889703.9049687"],
  ])("%s", (_label, quoted, bps, expected) => {
    expect(maxSendAfterSlippage(quoted, bps)).toBe(expected);
  });

  it("never returns less than the quote", () => {
    for (const quoted of ["0.0000001", "0.0000009", "1.2345678", "99999.9999999"]) {
      for (const bps of [0, 1, 50, 499, 500]) {
        expect(Number(maxSendAfterSlippage(quoted, bps))).toBeGreaterThanOrEqual(Number(quoted));
      }
    }
  });
});

describe("isValidSlippageBps", () => {
  it("defaults to 50 and caps at 500", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(50);
    expect(MAX_SLIPPAGE_BPS).toBe(500);
  });

  it.each([0, 1, 50, 500])("accepts %p", (bps) => expect(isValidSlippageBps(bps)).toBe(true));
  it.each([-1, 501, 1.5, "50", null, undefined, NaN])("rejects %p", (bps) =>
    expect(isValidSlippageBps(bps)).toBe(false)
  );
});
