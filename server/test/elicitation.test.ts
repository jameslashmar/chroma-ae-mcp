/**
 * ae_ask_user through the client's own UI (MCP elicitation/create) when the client handles it,
 * and the panel otherwise.
 */

import { describe, expect, it } from "vitest";
import { AskStore } from "../src/asks.js";
import { handleRpc } from "../src/mcp-rpc.js";
import type { ToolContext } from "../src/tools/common.js";

const options = [
  { id: "a", label: "Ease in", description: "slow start" },
  { id: "b", label: "Ease out" },
];
const ask = (id: number, extra: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "ae_ask_user", arguments: { question: "Which ease?", options, wait_seconds: 5, ...extra } },
});

/** Runs ae_ask_user with a client that answers each elicitation/create with `answer` (or nothing). */
async function run(answer: ((req: any) => Record<string, unknown>) | null, extra: Record<string, unknown> = {}, elicitation = true) {
  const ctx = { asks: new AskStore() } as unknown as ToolContext;
  const sent: any[] = [];
  const notify = (m: Record<string, unknown>) => {
    sent.push(m);
    if (m.method === "elicitation/create" && answer) {
      // The client's answer comes back as its own message, like a separate POST.
      setTimeout(() => void handleRpc({ jsonrpc: "2.0", id: m.id, ...answer(m) }, ctx), 5);
    }
  };
  const res: any = await handleRpc(ask(1, extra), ctx, { notify, elicitation });
  return { body: JSON.parse(res.result.content[0].text), sent };
}

describe("ae_ask_user through elicitation", () => {
  it("sends the options as an enum with their labels and returns the choice", async () => {
    const { body, sent } = await run(() => ({ result: { action: "accept", content: { choice: "b" } } }));
    const req = sent.find((m) => m.method === "elicitation/create");
    expect(req.params.requestedSchema.properties.choice).toMatchObject({ enum: ["a", "b"], enumNames: ["Ease in", "Ease out"] });
    expect(req.params.message).toContain("Which ease?");
    expect(req.params.message).toContain("Ease in: slow start");
    expect(body).toMatchObject({ ok: true, status: "answered", via: "elicitation" });
    expect(JSON.stringify(body)).toContain("Ease out");
  });

  it("free text when allow_other; decline is dismissed", async () => {
    const other = await run(() => ({ result: { action: "accept", content: { other: "  linear please " } } }));
    expect(other.body).toMatchObject({ status: "answered", via: "elicitation" });
    expect(JSON.stringify(other.body)).toContain("linear please");
    const declined = await run(() => ({ result: { action: "decline" } }));
    expect(declined.body).toMatchObject({ status: "dismissed", via: "elicitation" });
  });

  it("no answer in time says so", async () => {
    const { body } = await run(null, { wait_seconds: 0 });
    expect(body).toMatchObject({ status: "no_answer", via: "elicitation" });
  });

  it("a client that refuses the request falls back to the panel", async () => {
    // The refusal arrives at once; the panel then waits wait_seconds (1 s here) and reports the question as queued.
    const { body } = await run(() => ({ error: { code: -32601, message: "no elicitation here" } }), { wait_seconds: 1 });
    expect(body.via).toBeUndefined();
    expect(body.status).toBe("waiting"); // queued in the panel
  });

  it("multi_select, pictures and clients without elicitation use the panel and send no request", async () => {
    for (const [extra, el] of [[{ multi_select: true, wait_seconds: 0 }, true], [{ wait_seconds: 0 }, false]] as const) {
      const { body, sent } = await run(() => ({ result: { action: "accept", content: { choice: "a" } } }), extra, el);
      expect(sent.some((m) => m.method === "elicitation/create")).toBe(false);
      expect(body.status).toBe("waiting");
    }
  });
});
