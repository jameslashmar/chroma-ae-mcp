import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleRpc, type JsonRpcErrorResponse, type JsonRpcSuccessResponse } from "../src/mcp-rpc.js";
import { CAPTIONS_GUIDANCE_FILES, GUIDANCE_FILES } from "../src/guidance/content.generated.js";
import type { ToolContext } from "../src/tools/common.js";

const ctx = {} as ToolContext;
const guidanceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "guidance");
const dir = path.join(guidanceRoot, "motion-director");
const captionsDir = path.join(guidanceRoot, "captions");

async function rpc(method: string, params?: unknown): Promise<any> {
  return handleRpc({ jsonrpc: "2.0", id: 1, method, params }, ctx);
}

function walk(d: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(d, e.name), rel));
    else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out.sort();
}

describe("motion guidance: generated module", () => {
  it("is in sync with server/guidance (run: node scripts/sync-guidance.mjs)", () => {
    const files = walk(dir);
    expect(Object.keys(GUIDANCE_FILES).sort()).toEqual(files);
    for (const rel of files) {
      const disk = fs.readFileSync(path.join(dir, rel), "utf8").replace(/\r\n/g, "\n");
      expect(GUIDANCE_FILES[rel], rel).toBe(disk);
    }
  });

  it("captions module is in sync with server/guidance/captions", () => {
    const files = walk(captionsDir);
    expect(Object.keys(CAPTIONS_GUIDANCE_FILES).sort()).toEqual(files);
    for (const rel of files) {
      const disk = fs.readFileSync(path.join(captionsDir, rel), "utf8").replace(/\r\n/g, "\n");
      expect(CAPTIONS_GUIDANCE_FILES[rel], rel).toBe(disk);
    }
  });

  it("includes SKILL.md, NOTICE.md and the review reference", () => {
    expect(GUIDANCE_FILES["SKILL.md"]).toContain("Chroma motion director");
    expect(GUIDANCE_FILES["NOTICE.md"]).toBeTruthy();
    expect(GUIDANCE_FILES["references/review.md"]).toBeTruthy();
  });
});

describe("motion guidance: MCP prompts and resources", () => {
  it("initialize advertises prompts and resources", async () => {
    const res = (await rpc("initialize", { protocolVersion: "2025-06-18" })) as JsonRpcSuccessResponse;
    const caps = (res.result as any).capabilities;
    expect(caps.tools).toBeTruthy();
    expect(caps.prompts).toEqual({ listChanged: false });
    expect(caps.resources.listChanged).toBe(false);
  });

  it("prompts/list returns all three prompts", async () => {
    const res = (await rpc("prompts/list")) as JsonRpcSuccessResponse;
    const prompts = (res.result as any).prompts;
    expect(prompts.map((p: any) => p.name)).toEqual(["motion_director", "motion_review", "captions"]);
    expect(prompts[0].arguments[0].name).toBe("task");
    expect(prompts[1].arguments[0].name).toBe("comp");
    expect(prompts[2].arguments[0].name).toBe("task");
    expect(prompts[2].arguments[0].required).toBe(false);
    expect(prompts[2].description).toContain("Captions guidance");
  });

  it("prompts/get captions returns the skill body, with the task appended", async () => {
    const res = (await rpc("prompts/get", { name: "captions", arguments: { task: "TikTok reel, 9:16" } })) as JsonRpcSuccessResponse;
    const text = (res.result as any).messages[0].content.text as string;
    expect(text).toContain("# Captions");
    expect(text).not.toMatch(/^---/);
    expect(text).toContain("Task: TikTok reel, 9:16");
    const bare = (await rpc("prompts/get", { name: "captions" })) as JsonRpcSuccessResponse;
    expect((bare.result as any).messages[0].content.text).not.toContain("Task:");
  });

  it("prompts/get motion_director returns the skill, with the task appended", async () => {
    const res = (await rpc("prompts/get", { name: "motion_director", arguments: { task: "10s logo sting" } })) as JsonRpcSuccessResponse;
    const r = res.result as any;
    expect(r.description).toBeTruthy();
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe("user");
    expect(r.messages[0].content.type).toBe("text");
    expect(r.messages[0].content.text).toContain("# Chroma motion director");
    expect(r.messages[0].content.text).not.toMatch(/^---/);
    expect(r.messages[0].content.text).toContain("Task: 10s logo sting");
  });

  it("prompts/get works without arguments and for motion_review", async () => {
    const a = (await rpc("prompts/get", { name: "motion_director" })) as JsonRpcSuccessResponse;
    expect((a.result as any).messages[0].content.text).not.toContain("Task:");
    const b = (await rpc("prompts/get", { name: "motion_review", arguments: { comp: "Main" } })) as JsonRpcSuccessResponse;
    const text = (b.result as any).messages[0].content.text as string;
    expect(text).toContain("# Review: measure, then look");
    expect(text).toContain("Comp to review: Main");
  });

  it("prompts/get with an unknown name or bad argument is -32602", async () => {
    const a = (await rpc("prompts/get", { name: "nope" })) as JsonRpcErrorResponse;
    expect(a.error.code).toBe(-32602);
    expect(a.error.message).toContain("motion_director");
    const b = (await rpc("prompts/get", { name: "motion_director", arguments: { task: 5 } })) as JsonRpcErrorResponse;
    expect(b.error.code).toBe(-32602);
    const c = (await rpc("prompts/get", {})) as JsonRpcErrorResponse;
    expect(c.error.code).toBe(-32602);
  });

  it("resources/list has one entry per guidance file, motion-director first, then captions", async () => {
    const res = (await rpc("resources/list")) as JsonRpcSuccessResponse;
    const resources = (res.result as any).resources;
    const total = Object.keys(GUIDANCE_FILES).length + Object.keys(CAPTIONS_GUIDANCE_FILES).length;
    expect(resources).toHaveLength(total);
    const firstCaptions = resources.findIndex((r: any) => r.uri.startsWith("chroma-ae://guidance/captions/"));
    expect(firstCaptions).toBe(Object.keys(GUIDANCE_FILES).length);
    for (const r of resources) {
      expect(r.uri).toMatch(/^chroma-ae:\/\/guidance\/(motion-director|captions)\//);
      expect(r.name).toBeTruthy();
      expect(r.description).toBeTruthy();
      expect(r.mimeType).toBe("text/markdown");
    }
    const uris = resources.map((r: any) => r.uri);
    expect(uris).toContain("chroma-ae://guidance/motion-director/SKILL.md");
    expect(uris).toContain("chroma-ae://guidance/motion-director/NOTICE.md");
    expect(uris).toContain("chroma-ae://guidance/motion-director/references/timing-and-easing.md");
    expect(uris).toContain("chroma-ae://guidance/captions/SKILL.md");
    expect(uris).toContain("chroma-ae://guidance/captions/references/standards.md");
  });

  it("resources/read returns the file text", async () => {
    const uri = "chroma-ae://guidance/motion-director/references/timing-and-easing.md";
    const res = (await rpc("resources/read", { uri })) as JsonRpcSuccessResponse;
    const c = (res.result as any).contents;
    expect(c).toHaveLength(1);
    expect(c[0]).toEqual({ uri, mimeType: "text/markdown", text: GUIDANCE_FILES["references/timing-and-easing.md"] });
  });

  it("resources/read returns a captions reference text", async () => {
    const uri = "chroma-ae://guidance/captions/references/standards.md";
    const res = (await rpc("resources/read", { uri })) as JsonRpcSuccessResponse;
    const c = (res.result as any).contents;
    expect(c).toHaveLength(1);
    expect(c[0]).toEqual({ uri, mimeType: "text/markdown", text: CAPTIONS_GUIDANCE_FILES["references/standards.md"] });
    expect(c[0].text).toContain("Netflix");
  });

  it("resources/read with an unknown captions uri is -32002 (not found)", async () => {
    const a = (await rpc("resources/read", { uri: "chroma-ae://guidance/captions/nope.md" })) as JsonRpcErrorResponse;
    expect(a.error.code).toBe(-32002);
  });

  it("resources/read with an unknown uri is -32002 (not found), a missing one -32602", async () => {
    const a = (await rpc("resources/read", { uri: "chroma-ae://guidance/motion-director/nope.md" })) as JsonRpcErrorResponse;
    expect(a.error.code).toBe(-32002);
    const b = (await rpc("resources/read", {})) as JsonRpcErrorResponse;
    expect(b.error.code).toBe(-32602);
  });
});
