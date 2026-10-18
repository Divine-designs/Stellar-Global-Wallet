/**
 * Exact decimal <-> stroop conversion for Stellar amounts. Amounts travel as
 * strings everywhere in this API (see @globe-wallet/sdk `isValidStellarAmount`)
 * and must never be compared as JS numbers — floating point can't represent
 * every 7-decimal value exactly, so `0.1 + 0.2`-style drift could flip a
 * minimum-balance or spendable-balance check. 1 XLM = 10_000_000 stroops.
 */
const STROOPS_PER_UNIT = 10_000_000n;

export function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d{1,7})?$/.test(unsigned)) {
    throw new Error(`Invalid Stellar amount: ${amount}`);
  }
  const [whole, fraction = ""] = unsigned.split(".");
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0"));
  return negative ? -stroops : stroops;
}

export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = (abs % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
