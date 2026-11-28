/**
 * MCP revision 2026-07-28 next to the legacy revisions: era classification, the modern methods,
 * the streamable-HTTP header rules, client labels and cancellation on connection close.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/call-context.js", async () => {
  const real = await vi.importActual<typeof import("../src/call-context.js")>("/src/call-context.ts");
  return { ...real, cancelCall: vi.fn(real.cancelCall), runInCall: vi.fn(real.runInCall) };
});

import { cancelCall, runInCall, type CallState } from "../src/call-context.js";
import { getMcpSkill, listMcpSkillResources, listMcpSkills } from "../src/guidance/mcp-skills.js";
import {
  ALL_PROTOCOL_VERSIONS,
  CACHE_TTL_MS,
  classifyRequest,
  decodeHeaderValue,
  decorateResult,
  sanitizeClientLabel,
  validateModernHeaders,
} from "../src/mcp-modern.js";
import { coreInstructions } from "../src/toolsets.js";
import { handleRpc, listTools, SERVER_NAME, SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp-rpc.js";
import { createPanelMcp } from "../src/panel-entry.js";
import { AskStore } from "../src/asks.js";
import type { ToolContext } from "../src/tools/common.js";

const V = "io.modelcontextprotocol/protocolVersion";
const CAPS = "io.modelcontextprotocol/clientCapabilities";
const INFO = "io.modelcontextprotocol/clientInfo";
const SERVER = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.mocked(cancelCall).mockClear();
  vi.mocked(runInCall).mockClear();
});

/** The CallState of every tools/call run so far, in order (captured from runInCall). */
function callStates(): CallState[] {
  return vi.mocked(runInCall).mock.calls.map((c) => c[0] as CallState);
}
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-modern-"));
  dirs.push(d);
  return d;
};

function meta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { [V]: "2026-07-28", [CAPS]: {}, [INFO]: { name: "Test Client", version: "1" }, ...extra };
}
function modern(id: number | string, method: string, params: Record<string, unknown> = {}, metaExtra: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...meta(metaExtra), ...((params._meta as object) ?? {}) } } };
}
function headersFor(body: { method: string; params?: Record<string, unknown> }, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "mcp-protocol-version": "2026-07-28", "mcp-method": body.method };
  const name = body.method === "resources/read" || body.method === "skills/get" ? body.params?.uri : body.params?.name;
  if (typeof name === "string") h["mcp-name"] = name;
  return { ...h, ...extra };
}

function makeCtx(onEval?: (script: string) => unknown): { ctx: ToolContext; evals: string[] } {
  const evals: string[] = [];
  const mcp = createPanelMcp({
    dataDir: tmp(),
    watchAssets: false,
    sessionTracking: false,
    evalScript: async (script) => {
      evals.push(script);
      return { ok: true, result: onEval ? await onEval(script) : { id: 5, name: "Comp", numLayers: 0, layers: [] }, durationMs: 1 };
    },
  });
  return { ctx: mcp.ctx, evals };
}

async function rpc(msg: unknown, opts: Parameters<typeof handleRpc>[2] = {}) {
  const { ctx } = makeCtx();
  return (await handleRpc(msg, ctx, opts)) as any;
}

describe("classification", () => {
  it("serves requests without _meta as legacy", () => {
    expect(classifyRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual({ era: "legacy" });
    expect(classifyRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).toEqual({ era: "legacy" });
    expect(classifyRequest({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({ era: "legacy" });
    expect(classifyRequest("nope")).toEqual({ era: "legacy" });
    expect(classifyRequest([])).toEqual({ era: "legacy" });
  });

  it("serves a legacy version in _meta as legacy, even for the modern-only methods' siblings", () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(classifyRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [V]: v } } })).toEqual({ era: "legacy" });
    }
  });

  it("classifies a modern version with its capabilities and clientInfo", () => {
    const c = classifyRequest(modern(1, "tools/list"));
    expect(c).toEqual({ era: "modern", version: "2026-07-28", clientCapabilities: {}, clientInfo: { name: "Test Client", version: "1" } });
  });

  it("ignores a malformed clientInfo", () => {
    const c = classifyRequest(modern(1, "tools/list", {}, { [INFO]: "x" }));
    expect(c).toEqual({ era: "modern", version: "2026-07-28", clientCapabilities: {} });
  });

  it("answers an unknown or non-string version with -32022 listing the supported ones", () => {
    for (const bad of ["2099-01-01", 20260728, null, ["2026-07-28"]]) {
      const c = classifyRequest({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: { [V]: bad } } });
      expect(c).toMatchObject({ era: "error", httpStatus: 400 });
      const err = (c as any).response;
      expect(err.id).toBe(9);
      expect(err.error.code).toBe(-32022);
      expect(err.error.data).toEqual({ supported: ALL_PROTOCOL_VERSIONS, requested: bad });
    }
    expect(ALL_PROTOCOL_VERSIONS).toEqual(["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"]);
  });

  it("needs clientCapabilities (an object) for a modern request: -32602", () => {
    for (const caps of [undefined, null, "x", []]) {
      const m: Record<string, unknown> = { [V]: "2026-07-28" };
      if (caps !== undefined) m[CAPS] = caps;
      const c = classifyRequest({ jsonrpc: "2.0", id: "a", method: "tools/list", params: { _meta: m } });
      expect((c as any).response.error.code).toBe(-32602);
      expect((c as any).response.error.message).toContain("clientCapabilities");
      expect((c as any).response.id).toBe("a");
    }
  });

  it("needs the _meta version for the modern-only methods: -32602 with data.supported", () => {
    for (const method of ["server/discover", "skills/list", "skills/get"]) {
      const c = classifyRequest({ jsonrpc: "2.0", id: 3, method });
      expect(c).toMatchObject({ era: "error", httpStatus: 400 });
      expect((c as any).response.error.code).toBe(-32602);
      expect((c as any).response.error.data).toEqual({ supported: ALL_PROTOCOL_VERSIONS });
    }
  });

  it("is applied by handleRpc without changing the legacy path", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "server/discover" });
    expect(res.error.code).toBe(-32602);
    const legacyMeta = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [V]: "2025-06-18" } } }, { toolset: "full" });
    expect(legacyMeta.result.resultType).toBeUndefined();
    expect(Array.isArray(legacyMeta.result.tools)).toBe(true);
  });
});

describe("decorateResult and helpers", () => {
  it("adds resultType and serverInfo and keeps existing _meta", () => {
    expect(decorateResult({ a: 1, _meta: { x: 1 } }, SERVER_INFO)).toEqual({ a: 1, resultType: "complete", _meta: { x: 1, [SERVER]: SERVER_INFO } });
    expect(decorateResult({}, SERVER_INFO)).toEqual({ resultType: "complete", _meta: { [SERVER]: SERVER_INFO } });
  });

  it("sanitises client labels like the header rule", () => {
    expect(sanitizeClientLabel("  Claude\u00e9Code\tCLI  ")).toBe("Claude Code CLI");
    expect(sanitizeClientLabel("x".repeat(80))).toHaveLength(40);
    expect(sanitizeClientLabel(42)).toBe("");
  });

  it("decodes the Base64 sentinel as UTF-8", () => {
    const enc = (s: string) => `=?base64?${Buffer.from(s, "utf8").toString("base64")}?=`;
    expect(decodeHeaderValue(enc("caf\u00e9 tool"))).toBe("caf\u00e9 tool");
    expect(decodeHeaderValue("plain")).toBe("plain");
    expect(decodeHeaderValue("=?base64?%%%?=")).toBeNull();
    expect(decodeHeaderValue("=?base64?/w==?=")).toBeNull(); // 0xFF is not UTF-8
  });
});

describe("validateModernHeaders", () => {
  const call = { method: "tools/call", params: { name: "ae_get_comp" } };
  const ok = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "ae_get_comp" };

  it("accepts matching headers (any header-name case)", () => {
    expect(validateModernHeaders(ok, call, "2026-07-28")).toEqual({ ok: true });
    expect(validateModernHeaders({ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "ae_get_comp" }, call, "2026-07-28")).toEqual({ ok: true });
  });

  it("rejects missing or mismatched protocol version, method and name", () => {
    const bad = (h: Record<string, string | undefined>, body = call) => validateModernHeaders(h, body, "2026-07-28");
    for (const h of [
      { ...ok, "mcp-protocol-version": undefined },
      { ...ok, "mcp-protocol-version": "2025-06-18" },
      { ...ok, "mcp-method": undefined },
      { ...ok, "mcp-method": "tools/list" },
      { ...ok, "mcp-name": undefined },
      { ...ok, "mcp-name": "other" },
    ]) {
      const r = bad(h);
      expect(r.ok).toBe(false);
      expect((r as any).message).toMatch(/^Header mismatch: /);
    }
  });

  it("needs Mcp-Name for prompts/get and resources/read, and checks it on skills/get when sent", () => {
    const h = { "mcp-protocol-version": "2026-07-28" };
    expect(validateModernHeaders({ ...h, "mcp-method": "prompts/get" }, { method: "prompts/get", params: { name: "captions" } }, "2026-07-28").ok).toBe(false);
    expect(validateModernHeaders({ ...h, "mcp-method": "resources/read" }, { method: "resources/read", params: { uri: "x://y" } }, "2026-07-28").ok).toBe(false);
    expect(validateModernHeaders({ ...h, "mcp-method": "resources/read", "mcp-name": "x://y" }, { method: "resources/read", params: { uri: "x://y" } }, "2026-07-28").ok).toBe(true);
    const get = { method: "skills/get", params: { uri: "skill://a/SKILL.md" } };
    expect(validateModernHeaders({ ...h, "mcp-method": "skills/get" }, get, "2026-07-28").ok).toBe(true);
    expect(validateModernHeaders({ ...h, "mcp-method": "skills/get", "mcp-name": "skill://a/SKILL.md" }, get, "2026-07-28").ok).toBe(true);
    expect(validateModernHeaders({ ...h, "mcp-method": "skills/get", "mcp-name": "skill://b/SKILL.md" }, get, "2026-07-28").ok).toBe(false);
    // tools/list carries no name: a stray Mcp-Name is ignored
    expect(validateModernHeaders({ ...h, "mcp-method": "tools/list", "mcp-name": "zzz" }, { method: "tools/list" }, "2026-07-28").ok).toBe(true);
  });

  it("decodes the Base64 sentinel before comparing", () => {
    const name = "caf\u00e9 tool";
    const body = { method: "tools/call", params: { name } };
    const enc = (s: string) => `=?base64?${Buffer.from(s, "utf8").toString("base64")}?=`;
    const h = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" };
    expect(validateModernHeaders({ ...h, "mcp-name": enc(name) }, body, "2026-07-28").ok).toBe(true);
    expect(validateModernHeaders({ ...h, "mcp-name": enc("other") }, body, "2026-07-28").ok).toBe(false);
    expect(validateModernHeaders({ ...h, "mcp-name": "=?base64?!!!?=" }, body, "2026-07-28").ok).toBe(false);
    // a plain value that merely looks like the sentinel is compared after decoding too
    const odd = enc("x");
    expect(validateModernHeaders({ ...h, "mcp-name": odd }, { method: "tools/call", params: { name: odd } }, "2026-07-28").ok).toBe(false);
    expect(validateModernHeaders({ ...h, "mcp-name": enc(odd) }, { method: "tools/call", params: { name: odd } }, "2026-07-28").ok).toBe(true);
  });

  it("rejects header values with characters outside printable ASCII and tab", () => {
    const r = validateModernHeaders({ ...ok, "mcp-name": "ae_get_comp\u00e9" }, { method: "tools/call", params: { name: "ae_get_comp\u00e9" } }, "2026-07-28");
    expect(r.ok).toBe(false);
    expect((r as any).message).toContain("invalid characters");
    expect(validateModernHeaders({ ...ok, "mcp-method": "tools/call\n" }, call, "2026-07-28").ok).toBe(false);
  });
});

describe("modern dispatch over handleRpc", () => {
  function expectDecorated(res: any, id: number | string) {
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(id);
    expect(res.result.resultType).toBe("complete");
    expect(res.result._meta[SERVER]).toEqual(SERVER_INFO);
  }

  it("server/discover has the exact shape (core carries instructions, full does not)", async () => {
    const core = await rpc(modern(1, "server/discover"), { toolset: "core" });
    expectDecorated(core, 1);
    expect(core.result).toEqual({
      supportedVersions: ["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"],
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        extensions: { "io.modelcontextprotocol/skills": {} },
      },
      instructions: coreInstructions(),
      ttlMs: CACHE_TTL_MS,
      cacheScope: "private",
      resultType: "complete",
      _meta: { [SERVER]: SERVER_INFO },
    });
    const full = await rpc(modern(2, "server/discover"), { toolset: "full" });
    expect("instructions" in full.result).toBe(false);
    expect(full.result.cacheScope).toBe("private");
    expect(full.result.supportedVersions).toEqual(core.result.supportedVersions);
  });

  it("every method answers resultType complete with serverInfo; cacheable ones carry ttlMs and the right scope", async () => {
    const firstSkill = listMcpSkills()[0];
    const cases: Array<[string, Record<string, unknown>, "public" | "private"]> = [
      ["server/discover", {}, "private"],
      ["tools/list", {}, "private"],
      ["prompts/list", {}, "public"],
      ["resources/list", {}, "public"],
      ["resources/templates/list", {}, "public"],
      ["skills/list", {}, "public"],
      ["skills/get", { uri: firstSkill.uri }, "public"],
    ];
    let n = 0;
    for (const [method, params, scope] of cases) {
      const res = await rpc(modern(++n, method, params));
      expectDecorated(res, n);
      expect(res.result.ttlMs).toBeGreaterThanOrEqual(0);
      expect(res.result.cacheScope).toBe(scope);
    }
    const prompt = await rpc(modern(50, "prompts/get", { name: "captions" }));
    expectDecorated(prompt, 50);
    expect(prompt.result.messages[0].role).toBe("user");
    const read = await rpc(modern(51, "resources/read", { uri: firstSkill.uri }));
    expectDecorated(read, 51);
    expect(read.result.cacheScope).toBe("public");
    expect(read.result.ttlMs).toBe(CACHE_TTL_MS);
  });

  it("tools/list equals the legacy list, is stable, and follows the toolset", async () => {
    for (const toolset of ["full", "core"] as const) {
      const legacy = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { toolset });
      const a = await rpc(modern(1, "tools/list"), { toolset });
      const b = await rpc(modern(2, "tools/list"), { toolset });
      expect(a.result.tools).toEqual(legacy.result.tools);
      expect(a.result.tools).toEqual(listTools(toolset));
      expect(a.result.tools.map((t: any) => t.name)).toEqual(b.result.tools.map((t: any) => t.name));
    }
    const core = await rpc(modern(1, "tools/list"), { toolset: "core" });
    const full = await rpc(modern(1, "tools/list"), { toolset: "full" });
    expect(core.result.tools.length).toBeLessThan(full.result.tools.length);
    expect(core.result.tools.slice(0, 3).map((t: any) => t.name)).toEqual(["ae_search_tools", "ae_get_tool_schema", "ae_invoke_tool"]);
  });

  it("tools/call runs the tool and decorates the result; meta-tools work too; unknown tools stay isError results", async () => {
    const { ctx, evals } = makeCtx();
    const res: any = await handleRpc(modern(7, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } }), ctx, { toolset: "full" });
    expectDecorated(res, 7);
    expect(res.result.content[0].type).toBe("text");
    expect(evals).toContain('__chromaAe.getComp({"comp_id":5})');

    const meta: any = await handleRpc(modern(8, "tools/call", { name: "ae_search_tools", arguments: { query: "caption" } }), ctx, { toolset: "core" });
    expectDecorated(meta, 8);
    expect(meta.result.isError).not.toBe(true);

    const unknown: any = await handleRpc(modern(9, "tools/call", { name: "ae_nope", arguments: {} }), ctx, {});
    expectDecorated(unknown, 9);
    expect(unknown.result.isError).toBe(true);

    const noName: any = await handleRpc(modern(10, "tools/call", {}), ctx, {});
    expect(noName.error.code).toBe(-32602);
  });

  it("modern tools/call sends progress over notify, and never asks the client a question", async () => {
    const { ctx } = makeCtx();
    const sent: any[] = [];
    const res: any = await handleRpc(
      modern(11, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 }, _meta: { progressToken: "tok" } }),
      ctx,
      { notify: (m) => sent.push(m), elicitation: true }
    );
    expectDecorated(res, 11);
    expect(sent.some((m) => m.method === "notifications/progress" && m.params.progressToken === "tok")).toBe(true);

    const askCtx = { asks: new AskStore() } as unknown as ToolContext;
    const asked: any[] = [];
    const ask: any = await handleRpc(
      modern(12, "tools/call", { name: "ae_ask_user", arguments: { question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], wait_seconds: 0 } }),
      askCtx,
      { notify: (m) => asked.push(m), elicitation: true }
    );
    expect(asked.some((m) => m.method === "elicitation/create")).toBe(false);
    const body = JSON.parse(ask.result.content[0].text);
    expect(body.via).toBeUndefined();
    expect(body.status).toBe("waiting");
  });

  it("prompts/get errors are the legacy errors", async () => {
    const legacy = await rpc({ jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "nope" } });
    const m = await rpc(modern(1, "prompts/get", { name: "nope" }));
    expect(m.error).toEqual(legacy.error);
  });

  it("modern resources/list lists the skill files; legacy keeps the guidance list; templates are empty", async () => {
    const legacy = await rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    const m = await rpc(modern(1, "resources/list"));
    expect(m.result.resources).toEqual(listMcpSkillResources());
    expect(m.result.cacheScope).toBe("public");
    expect(m.result.ttlMs).toBe(CACHE_TTL_MS);
    expect(m.result.resources.every((r: any) => r.uri.startsWith("skill://") && r.mimeType && r.size > 0)).toBe(true);
    expect(legacy.result.resources.every((r: any) => r.uri.startsWith("chroma-ae://guidance/"))).toBe(true);
    // every file of every skill, SKILL.md first, skills sorted by name
    const skills = listMcpSkills();
    expect(m.result.resources.map((r: any) => r.uri)).toEqual(skills.flatMap((s) => s.resources.map((r) => r.uri)));
    for (const s of skills) {
      const entry = m.result.resources.find((r: any) => r.uri === s.uri);
      expect(entry).toMatchObject({ name: s.frontmatter.name, description: s.frontmatter.description, mimeType: "text/markdown" });
      expect(s.resources[0].uri).toBe(s.uri);
    }
    const ref = m.result.resources.find((r: any) => r.uri === "skill://chroma-motion-director/references/spec.md");
    expect(ref).toMatchObject({ name: "references/spec.md", description: expect.any(String), title: expect.any(String) });
    for (const r of m.result.resources) {
      const read = await rpc(modern(2, "resources/read", { uri: r.uri }));
      expect(read.result.contents[0].uri).toBe(r.uri);
      expect(Buffer.byteLength(read.result.contents[0].text, "utf8")).toBe(r.size);
    }
    const t = await rpc(modern(2, "resources/templates/list"));
    expect(t.result.resourceTemplates).toEqual([]);
    const lt = await rpc({ jsonrpc: "2.0", id: 3, method: "resources/templates/list" });
    expect(lt.error.code).toBe(-32601); // legacy keeps it
  });

  it("resources/read serves guidance and skill files; unknown is -32602 with data.uri (legacy keeps -32002)", async () => {
    const legacyList = await rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    const guidanceUri = legacyList.result.resources[0].uri;
    const g = await rpc(modern(1, "resources/read", { uri: guidanceUri }));
    const lg = await rpc({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: guidanceUri } });
    expect(g.result.contents).toEqual(lg.result.contents);

    const skill = listMcpSkills()[0];
    const s = await rpc(modern(2, "resources/read", { uri: skill.uri }));
    expect(s.result.contents).toHaveLength(1);
    expect(s.result.contents[0]).toMatchObject({ uri: skill.uri, mimeType: "text/markdown" });
    expect(s.result.contents[0].text).toContain(skill.frontmatter.name);

    const missing = await rpc(modern(3, "resources/read", { uri: "chroma-ae://nope" }));
    expect(missing.error).toMatchObject({ code: -32602, data: { uri: "chroma-ae://nope" } });
    const missingSkill = await rpc(modern(4, "resources/read", { uri: "skill://nope/SKILL.md" }));
    expect(missingSkill.error).toMatchObject({ code: -32602, data: { uri: "skill://nope/SKILL.md" } });
    const noUri = await rpc(modern(5, "resources/read", {}));
    expect(noUri.error.code).toBe(-32602);
    const legacyMissing = await rpc({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "chroma-ae://nope" } });
    expect(legacyMissing.error.code).toBe(-32002);
    const legacySkill = await rpc({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: skill.uri } });
    expect(legacySkill.error.code).toBe(-32002);
  });

  it("skills/list equals listMcpSkills() and carries no cursor", async () => {
    const res = await rpc(modern(1, "skills/list"));
    expect(res.result.skills).toEqual(listMcpSkills());
    expect(res.result.skills.length).toBeGreaterThanOrEqual(2);
    expect(res.result.nextCursor).toBeUndefined();
    expect(res.result.ttlMs).toBe(CACHE_TTL_MS);
    expect(res.result.cacheScope).toBe("public");
    const uris = res.result.skills.map((s: any) => s.uri);
    expect(uris).toContain("skill://chroma-motion-director/SKILL.md");
    expect(uris).toContain("skill://captions/SKILL.md");
  });

  it("skills/get returns the entry; unknown or malformed uri is -32602", async () => {
    for (const s of listMcpSkills()) {
      const res = await rpc(modern(1, "skills/get", { uri: s.uri }));
      expect(res.result.skill).toEqual(getMcpSkill(s.uri));
      expect(res.result.skill).toEqual(s);
    }
    const unknown = await rpc(modern(2, "skills/get", { uri: "skill://nope/SKILL.md" }));
    expect(unknown.error.code).toBe(-32602);
    expect(unknown.error.message).toContain("skill://nope/SKILL.md");
    const notSkillMd = await rpc(modern(3, "skills/get", { uri: "skill://captions/references/x.md" }));
    expect(notSkillMd.error.code).toBe(-32602);
    for (const params of [{}, { uri: 5 }]) {
      const bad = await rpc(modern(4, "skills/get", params));
      expect(bad.error.code).toBe(-32602);
    }
  });

  it("removed and unknown methods are -32601 under modern", async () => {
    for (const method of ["ping", "initialize", "logging/setLevel", "completion/complete", "subscriptions/listen", "resources/directory/read", "nope/x"]) {
      const res = await rpc(modern(1, method));
      expect(res.error.code).toBe(-32601);
      expect(res.error.message).toBe(`Method not found: ${method}`);
    }
  });

  it("refuses a modern request inside a batch (2026-07-28 has no batches); legacy items are served as before", async () => {
    const res = await rpc([modern(1, "server/discover"), { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect(res[0]).toMatchObject({ id: 1, error: { code: -32600 } });
    expect(res[0].error.message).toMatch(/batch/);
    expect(res[1]).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });
});

describe("legacy behaviour is unchanged", () => {
  it("initialize, ping and the legacy lists answer exactly as before", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, { toolset: "full" });
    expect(init).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: SERVER_INFO,
      },
    });
    expect(await rpc({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await rpc({ jsonrpc: "2.0", id: 3, method: "server/discover", params: { _meta: { [V]: "2025-06-18" } } })).toMatchObject({ error: { code: -32601 } });
    const prompts = await rpc({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    expect(Object.keys(prompts.result)).toEqual(["prompts"]);
    const tools = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    expect(Object.keys(tools.result)).toEqual(["tools"]);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2025-06-18", "2025-03-26", "2024-11-05"]);
  });
});

// ---- HTTP ----

function makeRes() {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: 200,
    writableEnded: false,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    body: "",
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    write(chunk: string) {
      res.chunks.push(chunk);
      return true;
    },
    end(body?: string) {
      res.writableEnded = true;
      if (body !== undefined) res.body = body;
      (listeners.close ?? []).forEach((l) => l());
    },
    on(event: string, l: () => void) {
      (listeners[event] ??= []).push(l);
      return res;
    },
    /** The connection drops before a reply was written. */
    drop() {
      (listeners.close ?? []).forEach((l) => l());
    },
  };
  return res;
}

function makePanel(onEval?: (script: string) => unknown) {
  const evals: string[] = [];
  const mcp = createPanelMcp({
    dataDir: tmp(),
    watchAssets: false,
    sessionTracking: false,
    evalScript: async (script) => {
      evals.push(script);
      return { ok: true, result: onEval ? await onEval(script) : { id: 5, name: "Comp", numLayers: 0, layers: [] }, durationMs: 1 };
    },
  });
  return { mcp, evals };
}

async function post(mcp: ReturnType<typeof makePanel>["mcp"], body: unknown, headers: Record<string, string> = {}) {
  const res = makeRes();
  await mcp.handleHttp({ method: "POST", url: "/mcp", headers }, res, JSON.stringify(body));
  return { res, status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
}

describe("modern over HTTP", () => {
  it("answers a well-formed modern request with 200", async () => {
    const { mcp } = makePanel();
    const body = modern(1, "server/discover");
    const r = await post(mcp, body, headersFor(body));
    expect(r.status).toBe(200);
    expect(r.json.result.resultType).toBe("complete");
    expect(r.res.headers["Content-Type"]).toBe("application/json");
  });

  it("tools/list follows X-Chroma-Toolset through the header", async () => {
    const { mcp } = makePanel();
    const body = modern(1, "tools/list");
    const core = await post(mcp, body, headersFor(body, { "x-chroma-toolset": "core" }));
    const full = await post(mcp, body, headersFor(body, { "x-chroma-toolset": "full" }));
    expect(core.json.result.tools).toEqual(listTools("core"));
    expect(full.json.result.tools).toEqual(listTools("full"));
    const discoverBody = modern(2, "server/discover");
    const d = await post(mcp, discoverBody, headersFor(discoverBody, { "x-chroma-toolset": "core" }));
    expect(d.json.result.instructions).toBe(coreInstructions());
  });

  it("classification errors are a 400 with the JSON-RPC error and the body's id", async () => {
    const { mcp } = makePanel();
    const noMeta = await post(mcp, { jsonrpc: "2.0", id: 4, method: "skills/list" });
    expect(noMeta.status).toBe(400);
    expect(noMeta.json).toMatchObject({ id: 4, error: { code: -32602 } });
    const badVersion = await post(mcp, { jsonrpc: "2.0", id: "x", method: "tools/list", params: { _meta: { [V]: "1999-01-01" } } });
    expect(badVersion.status).toBe(400);
    expect(badVersion.json).toMatchObject({ id: "x", error: { code: -32022, data: { requested: "1999-01-01" } } });
    const noCaps = await post(mcp, { jsonrpc: "2.0", id: 5, method: "tools/list", params: { _meta: { [V]: "2026-07-28" } } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" });
    expect(noCaps.status).toBe(400);
    expect(noCaps.json.error.code).toBe(-32602);
  });

  it("header mismatches are 400 with -32020", async () => {
    const { mcp } = makePanel();
    const call = modern(1, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } });
    const good = headersFor(call);
    const variants: Array<Record<string, string>> = [
      {}, // no headers at all
      { ...good, "mcp-protocol-version": "2025-06-18" },
      (({ "mcp-protocol-version": _p, ...rest }) => rest)(good),
      { ...good, "mcp-method": "tools/list" },
      (({ "mcp-method": _m, ...rest }) => rest)(good),
      { ...good, "mcp-name": "ae_get_layers" },
      (({ "mcp-name": _n, ...rest }) => rest)(good),
      { ...good, "mcp-name": "ae_get_comp\u00e9" },
    ];
    for (const h of variants) {
      const r = await post(mcp, call, h);
      expect(r.status).toBe(400);
      expect(r.json.id).toBe(1);
      expect(r.json.error.code).toBe(-32020);
      expect(r.json.error.message).toMatch(/^Header mismatch: /);
    }
    expect((await post(mcp, call, good)).status).toBe(200);
  });

  it("accepts a Base64-sentinel Mcp-Name that decodes to the body value and rejects one that does not", async () => {
    const { mcp } = makePanel();
    const uri = "skill://captions/SKILL.md";
    const body = modern(1, "resources/read", { uri });
    const enc = (s: string) => `=?base64?${Buffer.from(s, "utf8").toString("base64")}?=`;
    const ok = await post(mcp, body, headersFor(body, { "mcp-name": enc(uri) }));
    expect(ok.status).toBe(200);
    expect(ok.json.result.contents[0].uri).toBe(uri);
    const bad = await post(mcp, body, headersFor(body, { "mcp-name": enc("skill://captions/other.md") }));
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe(-32020);
  });

  it("a header that differs from the body's _meta version is -32020 before the version is judged", async () => {
    const { mcp } = makePanel();
    const h = { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" };
    for (const bad of ["v999.0.0", 7]) {
      const r = await post(mcp, { jsonrpc: "2.0", id: 6, method: "server/discover", params: { _meta: { ...meta(), [V]: bad } } }, h);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ id: 6, error: { code: -32020 } });
    }
    // with no header (or an equal one) the unknown version is still -32022
    const none = await post(mcp, { jsonrpc: "2.0", id: 7, method: "server/discover", params: { _meta: { ...meta(), [V]: "v999.0.0" } } });
    expect(none.json.error.code).toBe(-32022);
    const same = await post(mcp, { jsonrpc: "2.0", id: 8, method: "server/discover", params: { _meta: { ...meta(), [V]: "v999.0.0" } } }, { "mcp-protocol-version": "v999.0.0" });
    expect(same.json.error.code).toBe(-32022);
    // a legacy body version with a differing legacy header is a mismatch too
    const legacy = await post(mcp, { jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: { [V]: "2025-06-18" } } }, { "mcp-protocol-version": "2025-03-26" });
    expect(legacy.status).toBe(400);
  });

  it("a modern header with a legacy body is -32020", async () => {
    const { mcp } = makePanel();
    const r = await post(mcp, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2026-07-28" });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ id: 2, error: { code: -32020 } });
    const withLegacyMeta = await post(mcp, { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { [V]: "2025-06-18" } } }, { "mcp-protocol-version": "2026-07-28" });
    expect(withLegacyMeta.status).toBe(400);
  });

  it("legacy requests with no headers, or legacy headers, are unchanged: 200 / 202", async () => {
    const { mcp } = makePanel();
    expect((await post(mcp, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).status).toBe(200);
    expect((await post(mcp, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" })).status).toBe(200);
    expect((await post(mcp, { jsonrpc: "2.0", id: 3, method: "ping" })).json).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    // legacy errors stay 200 (and -32601 stays 200 for legacy)
    const nf = await post(mcp, { jsonrpc: "2.0", id: 4, method: "nope" });
    expect(nf.status).toBe(200);
    expect(nf.json.error.code).toBe(-32601);
    const missing = await post(mcp, { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "x://y" } });
    expect(missing.status).toBe(200);
    expect(missing.json.error.code).toBe(-32002);
    // a notification stays a 202, even with a modern header
    const note = makeRes();
    await mcp.handleHttp({ method: "POST", headers: { "mcp-protocol-version": "2026-07-28" } }, note, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(note.statusCode).toBe(202);
  });

  it("-32601 on a modern request is a 404; ordinary modern errors stay 200", async () => {
    const { mcp } = makePanel();
    for (const method of ["ping", "initialize", "logging/setLevel"]) {
      const body = modern(1, method);
      const r = await post(mcp, body, headersFor(body));
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe(-32601);
    }
    const missing = modern(2, "resources/read", { uri: "chroma-ae://nope" });
    const r = await post(mcp, missing, headersFor(missing));
    expect(r.status).toBe(200);
    expect(r.json.error.code).toBe(-32602);
    const sk = modern(3, "skills/get", { uri: "skill://nope/SKILL.md" });
    expect((await post(mcp, sk, headersFor(sk))).status).toBe(200);
  });

  it("skills/list and skills/get over HTTP", async () => {
    const { mcp } = makePanel();
    const list = modern(1, "skills/list");
    const l = await post(mcp, list, headersFor(list));
    expect(l.status).toBe(200);
    expect(l.json.result.skills).toEqual(listMcpSkills());
    const get = modern(2, "skills/get", { uri: l.json.result.skills[0].uri });
    const g = await post(mcp, get, headersFor(get));
    expect(g.json.result.skill).toEqual(l.json.result.skills[0]);
  });

  it("tools/call over HTTP runs the tool (a meta-tool too)", async () => {
    const { mcp, evals } = makePanel();
    const call = modern(1, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } });
    const r = await post(mcp, call, headersFor(call));
    expect(r.status).toBe(200);
    expect(r.json.result.resultType).toBe("complete");
    expect(evals).toContain('__chromaAe.getComp({"comp_id":5})');
    const search = modern(2, "tools/call", { name: "ae_search_tools", arguments: { query: "layer" } });
    const s = await post(mcp, search, headersFor(search, { "x-chroma-toolset": "core" }));
    expect(s.status).toBe(200);
    expect(s.json.result.isError).not.toBe(true);
  });

  it("streams progress as an event stream for a modern call that asks for it", async () => {
    const { mcp } = makePanel();
    const call = modern(1, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 }, _meta: { progressToken: 9 } });
    const res = makeRes();
    await mcp.handleHttp({ method: "POST", headers: { ...headersFor(call), accept: "application/json, text/event-stream" } }, res, JSON.stringify(call));
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    const events = res.chunks.map((c) => JSON.parse(c.split("data: ")[1]));
    expect(events.some((e) => e.method === "notifications/progress" && e.params.progressToken === 9)).toBe(true);
    const last = events[events.length - 1];
    expect(last.id).toBe(1);
    expect(last.result.resultType).toBe("complete");
  });

  it("ignores X-Chroma-Elicitation for modern requests (no stream opened for it)", async () => {
    const { mcp } = makePanel();
    const call = modern(1, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } });
    const res = makeRes();
    await mcp.handleHttp(
      { method: "POST", headers: { ...headersFor(call), accept: "text/event-stream", "x-chroma-elicitation": "1" } },
      res,
      JSON.stringify(call)
    );
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.chunks).toEqual([]);
    expect(JSON.parse(res.body).result.resultType).toBe("complete");
  });
});

describe("client label and cancellation", () => {
  async function gatedPanel() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let started: () => void = () => undefined;
    const evalStarted = new Promise<void>((r) => (started = r));
    const { mcp } = makePanel(async () => {
      started();
      await gate;
      return { id: 5, name: "Comp", numLayers: 0, layers: [] };
    });
    return { mcp, release, evalStarted };
  }

  it("cancels a modern call when the client closes the connection before the reply, scoped by the clientInfo name", async () => {
    const { mcp, release, evalStarted } = await gatedPanel();
    const call = modern(21, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } }, { [INFO]: { name: "Probe\u00e9 Client", version: "1" } });
    const res = makeRes();
    const done = mcp.handleHttp({ method: "POST", headers: headersFor(call) }, res, JSON.stringify(call));
    await evalStarted;
    res.drop();
    const [state] = callStates();
    expect(state.client).toBe("Probe Client");
    expect(state.cancelled).toBe(true);
    expect(state.reason).toBe("the client closed the connection");
    release();
    await done;
  });

  it("the X-Chroma-Client header wins over clientInfo for the label", async () => {
    const { mcp, release, evalStarted } = await gatedPanel();
    const call = modern(22, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } });
    const res = makeRes();
    const done = mcp.handleHttp({ method: "POST", headers: headersFor(call, { "x-chroma-client": "From Header" }) }, res, JSON.stringify(call));
    await evalStarted;
    res.drop();
    const [state] = callStates();
    expect(state.client).toBe("From Header");
    expect(state.cancelled).toBe(true);
    release();
    await done;
  });

  it("a dropped connection cancels only its own call, not another session's call with the same label and id", async () => {
    const { mcp, release } = await gatedPanel();
    const call = modern(7, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } });
    const a = makeRes();
    const b = makeRes();
    const doneA = mcp.handleHttp({ method: "POST", headers: headersFor(call) }, a, JSON.stringify(call));
    const doneB = mcp.handleHttp({ method: "POST", headers: headersFor(call) }, b, JSON.stringify(call));
    await vi.waitFor(() => expect(callStates().length).toBe(2));
    a.drop();
    const [stateA, stateB] = callStates();
    expect(stateA.cancelled).toBe(true);
    expect(stateB.cancelled).toBe(false);
    expect(cancelCall).not.toHaveBeenCalled();
    release();
    await Promise.all([doneA, doneB]);
    expect(JSON.parse(b.body).result.resultType).toBe("complete");
  });

  it("a connection closed before the call starts still cancels it at its first safe point", async () => {
    const { mcp, evals } = makePanel();
    const call = modern(8, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } });
    const res = makeRes();
    const done = mcp.handleHttp({ method: "POST", headers: headersFor(call) }, res, JSON.stringify(call));
    res.drop();
    await done;
    const [state] = callStates();
    expect(state.cancelled).toBe(true);
    expect(evals).toEqual([]);
  });

  it("refuses a modern request inside a JSON-RPC batch over HTTP with 400 and -32600", async () => {
    const { mcp } = makePanel();
    const { status, json } = await post(mcp, [modern(1, "tools/list"), { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect(status).toBe(400);
    expect(json).toMatchObject({ id: null, error: { code: -32600 } });
    const legacy = await post(mcp, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect(legacy.status).toBe(200);
    expect(legacy.json).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]);
  });

  it("a modern event-stream reply says X-Accel-Buffering: no; a legacy one does not", async () => {
    const { mcp } = makePanel();
    const call = modern(9, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 }, _meta: { progressToken: "p1" } });
    const res = makeRes();
    await mcp.handleHttp({ method: "POST", headers: { ...headersFor(call), accept: "application/json, text/event-stream" } }, res, JSON.stringify(call));
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.headers["X-Accel-Buffering"]).toBe("no");
    const legacyRes = makeRes();
    const legacyCall = { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "ae_get_comp", arguments: { comp_id: 5 }, _meta: { progressToken: "p2" } } };
    await mcp.handleHttp({ method: "POST", headers: { accept: "application/json, text/event-stream" } }, legacyRes, JSON.stringify(legacyCall));
    expect(legacyRes.headers["Content-Type"]).toBe("text/event-stream");
    expect(legacyRes.headers["X-Accel-Buffering"]).toBeUndefined();
  });

  it("does not cancel when the reply was written, or for legacy calls", async () => {
    const { mcp } = makePanel();
    const call = modern(23, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } });
    const res = makeRes();
    await mcp.handleHttp({ method: "POST", headers: headersFor(call) }, res, JSON.stringify(call));
    expect(res.writableEnded).toBe(true);
    expect(callStates()[0].cancelled).toBe(false);

    const gated = await gatedPanel();
    const legacy = makeRes();
    const done = gated.mcp.handleHttp({ method: "POST", headers: {} }, legacy, JSON.stringify({ jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "ae_get_comp", arguments: { comp_id: 5 } } }));
    await gated.evalStarted;
    legacy.drop();
    expect(callStates()[1].cancelled).toBe(false);
    expect(cancelCall).not.toHaveBeenCalled();
    gated.release();
    await done;
  });

  it("works with a response object that has no on()", async () => {
    const { mcp } = makePanel();
    const call = modern(25, "tools/call", { name: "ae_get_comp", arguments: { comp_id: 5 } });
    let body = "";
    const res: any = { statusCode: 200, writableEnded: false, setHeader() {}, end(b?: string) { this.writableEnded = true; body = b ?? ""; } };
    await mcp.handleHttp({ method: "POST", headers: headersFor(call) }, res, JSON.stringify(call));
    expect(JSON.parse(body).result.resultType).toBe("complete");
  });
});
