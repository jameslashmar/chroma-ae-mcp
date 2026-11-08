import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/host.js";
import { callMetaTool } from "../src/meta-tools.js";
import { QueueWaitError } from "../src/queue.js";
import { formatToolError, formatToolResponse, type ToolContext } from "../src/tools/common.js";

describe("tool output is compact JSON", () => {
  it("formatToolResponse has no indentation or line breaks and parses back", () => {
    const data = { ok: true, items: [{ a: 1, b: "x" }, { a: 2, b: null }], nested: { deep: { deeper: [1, 2, 3] } } };
    const text = formatToolResponse(data).content[0].text;
    expect(text).toBe(JSON.stringify(data));
    expect(text).not.toMatch(/\n/);
    expect(JSON.parse(text)).toEqual(data);
  });

  it("keeps the 500-entry and 20k-character bounds the same", () => {
    const text = formatToolResponse({ list: Array.from({ length: 600 }, (_, i) => i), s: "x".repeat(20_500) }).content[0].text;
    const back = JSON.parse(text);
    expect(back.list).toHaveLength(500);
    expect(back.truncated).toBe(true);
    expect(back.list_total).toBe(600);
    expect(back.s).toContain("[truncated 500 chars]");
  });

  it("formatToolError data parts are compact; human messages are untouched", () => {
    const bridge = formatToolError(new BridgeError({ kind: "guard", message: "Expected project A\nbut found B" }));
    expect(bridge.isError).toBe(true);
    expect(bridge.content[0].text).not.toMatch(/\n/);
    expect(JSON.parse(bridge.content[0].text).message).toBe("Expected project A\nbut found B");
    const plain = formatToolError(new Error("plain failure"));
    expect(plain.content[0].text).toBe('{"kind":"error","message":"plain failure"}');
    const queue = formatToolError(new QueueWaitError("x", 5000, "y"));
    expect(queue.content[0].text).not.toMatch(/\n  /);
  });

  it("meta-tool results are compact", async () => {
    const ctx = {} as ToolContext;
    const res: any = await callMetaTool("ae_search_tools", {}, ctx);
    expect(res.content[0].text).not.toMatch(/\n/);
    expect(JSON.parse(res.content[0].text).total_tools).toBeGreaterThan(50);
  });
});
