import { readFileSync } from "fs";
import path from "path";

import { isGAddress } from "../utils/stellarAddress";
import { isValidMemoText } from "@globe-wallet/sdk";

/**
 * Loaded from the same file `packages/sdk/tests/validate.test.ts` reads —
 * issue #103's acceptance criterion is that the same vectors pass in both
 * the backend and the SDK. `backend/src/utils/stellarAddress.ts` is now a
 * re-export of `@globe-wallet/sdk`'s implementation (see that file), so
 * this is really asserting the shim re-exports correctly as much as it is
 * asserting the validation logic itself.
 */
const vectorsPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "sdk",
  "tests",
  "fixtures",
  "validation-vectors.json"
);
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  addresses: { value: unknown; valid: boolean; note?: string }[];
  memos: { value: string; validBytes: boolean; note?: string }[];
};

describe("isGAddress (re-exported from @globe-wallet/sdk)", () => {
  it.each(vectors.addresses.map((v) => [v.note ?? String(v.value), v.value, v.valid] as const))(
    "%s",
    (_label, value, valid) => {
      expect(isGAddress(value as string)).toBe(valid);
    }
  );
});

describe("isValidMemoText (from @globe-wallet/sdk, used in routes/wallet.ts)", () => {
  it.each(vectors.memos.map((v) => [v.note ?? v.value, v.value, v.validBytes] as const))(
    "%s",
    (_label, value, validBytes) => {
      expect(isValidMemoText(value)).toBe(validBytes);
    }
  );
});

/**
 * Issue #25: amounts must never be returned as JSON numbers. This guards the
 * OpenAPI spec so no `amount`/`balance`/`limit` field (or any field whose name
 * ends in one of those) is declared with `type: number`/`type: integer`.
 * Amounts are decimal strings with 7 dp; base-unit (stroop) values use the
 * `Amount` schema's `{ value, decimals }` form.
 */
const openapiPath = path.join(__dirname, "..", "..", "docs", "openapi.yaml");
const AMOUNT_FIELD = /(amount|balance|limit)$/i;

describe("OpenAPI amount fields (issue #25)", () => {
  const spec = readFileSync(openapiPath, "utf8");
  const lines = spec.split("\n");

  it("declares no amount/balance/limit field as a numeric type", () => {
    const offenders: string[] = [];
    lines.forEach((line, index) => {
      const fieldMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*$/);
      if (!fieldMatch) return;
      const [, indent, field] = fieldMatch;
      if (!AMOUNT_FIELD.test(field)) return;
      // Inspect the immediate child lines of this field for a numeric type.
      for (let i = index + 1; i < lines.length; i += 1) {
        const child = lines[i];
        if (child.trim() === "") continue;
        const childIndent = child.match(/^(\s*)/)?.[1].length ?? 0;
        if (childIndent <= indent.length) break;
        if (/^\s*type:\s*(number|integer)\s*$/.test(child)) {
          offenders.push(`${field} (line ${i + 1})`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });
});
