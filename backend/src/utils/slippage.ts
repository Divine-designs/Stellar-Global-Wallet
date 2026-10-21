import { fromStroops, toStroops } from "./stroops";

/** Slippage applied to a path payment quote when the client doesn't choose one (0.5%). */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** Highest tolerance a client may request (5%). */
export const MAX_SLIPPAGE_BPS = 500;

const BPS_DENOMINATOR = 10_000n;

export function isValidSlippageBps(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SLIPPAGE_BPS;
}

/**
 * Strict-send `destMin`: the least the destination must receive, i.e. the
 * quoted amount less `bps` basis points, rounded *down* to a stroop so the
 * protection is never looser than asked for. Stellar rejects a zero `destMin`,
 * so a quote so small that it rounds to nothing is floored at one stroop.
 * Integer stroop arithmetic throughout — never floats.
 */
export function minReceiveAfterSlippage(quotedAmount: string, bps: number): string {
  const floored = (toStroops(quotedAmount) * (BPS_DENOMINATOR - BigInt(bps))) / BPS_DENOMINATOR;
  return fromStroops(floored > 0n ? floored : 1n);
}

/**
 * Strict-receive `sendMax`: the most the source may spend, i.e. the quoted
 * amount plus `bps` basis points, rounded *up* to a stroop.
 */
export function maxSendAfterSlippage(quotedAmount: string, bps: number): string {
  const scaled = toStroops(quotedAmount) * (BPS_DENOMINATOR + BigInt(bps));
  return fromStroops((scaled + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR);
}
