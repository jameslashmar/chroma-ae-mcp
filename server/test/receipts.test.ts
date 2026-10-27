import { describe, expect, it } from "vitest";
import { boundOutput, buildReceipt, compareValues } from "../src/receipts.js";

describe("Receipt comparison and output bounding", () => {
  it("reports matches:true when requested values match read-back within float tolerance", () => {
    const receipt = buildReceipt({
      before: { value: [960, 540] },
      after: { value: [100.00001, 200, 0] },
      expected: { value: [100, 200] },
      actualForExpected: { value: [100.00001, 200, 0] },
    });

    expect(receipt.matches).toBe(true);
    expect(receipt.mismatches).toHaveLength(0);
  });

  it("reports matches:false with detailed mismatches without throwing", () => {
    const receipt = buildReceipt({
      before: { value: 100 },
      after: { value: 80 },
      expected: { value: 50 },
      actualForExpected: { value: 80 },
    });

    expect(receipt.matches).toBe(false);
    expect(receipt.mismatches).toHaveLength(1);
    expect(receipt.mismatches[0]).toMatchObject({
      path: "expected.value",
      expected: 50,
      actual: 80,
    });
  });

  it("compares nested objects and arrays accurately", () => {
    const diffs = compareValues(
      { a: 1, b: [10, 20], c: "ok" },
      { a: 1, b: [10, 99], c: "changed" },
      "root"
    );
    expect(diffs).toHaveLength(2);
    expect(diffs.map((d) => d.path)).toEqual(["root.b[1]", "root.c"]);
  });

  it("bounds list entries at 500 with truncated:true and strings at 20k chars", () => {
    const longList = Array.from({ length: 650 }, (_, i) => i);
    const longString = "x".repeat(25_000);

    const bounded = boundOutput({
      items: longList,
      text: longString,
    }) as Record<string, unknown>;

    expect(Array.isArray(bounded.items)).toBe(true);
    expect((bounded.items as unknown[]).length).toBe(500);
    expect(bounded.truncated).toBe(true);
    expect(typeof bounded.text).toBe("string");
    expect((bounded.text as string).length).toBeLessThan(20_100);
    expect(bounded.text as string).toContain("[truncated 5000 chars]");
  });
});
