import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lintEs3 } from "../src/es3-lint.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import {
  clearRecordedRunJsx,
  findSkill,
  formatSkillMd,
  listSkills,
  MAX_STEP_BYTES,
  parseSkillMd,
  recentRunJsx,
  recordRunJsx,
  writeSkill,
} from "../src/skills.js";
import type { ToolContext } from "../src/tools/common.js";
import { mutateTools } from "../src/tools/mutate.js";
import { AUTO_CHECKPOINT_TOOLS } from "../src/tools/ext/receipts.js";
import { AeSkillRunSchema, AeSkillSaveSchema, skillsTools } from "../src/tools/ext/skills.js";
import { ALL_TOOLS } from "../src/tools/registry.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => clearRecordedRunJsx());
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tool = (name: string) => skillsTools.find((t) => t.name === name)!;

/** A PanelHost whose AE answers from a script of results, recording each call and its args. */
function fakeAe(projectPath: string, results: Record<string, unknown[]>) {
  const calls: Array<{ fn: string; args: any }> = [];
  const dataDir = tempDir("chroma-skill-data-");
  const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
  const queue = new SingleWriterQueue();
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      if (fn === "status") return { ok: true, result: { project_path: projectPath }, durationMs: 1 };
      if (fn === "checkGuard") {
        return { ok: true, result: { ok: true, project_path: projectPath, comp_id: 1, comp_is_valid: true }, durationMs: 1 };
      }
      const q = results[fn];
      if (!q || q.length === 0) throw new Error(`Unexpected script: ${script}`);
      const next = q.shift();
      if (next instanceof Error) return { ok: false, error: { message: next.message, kind: "runtime" } };
      return { ok: true, result: next, durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir };
  return { ctx, calls, dataDir };
}

describe("lintEs3", () => {
  it("passes plain ES3", () => {
    expect(lintEs3('var a = 1;\nfunction f(x) { return x > 0 ? "a" : "b"; }\nvar s = "let const => `";\n// let x\nvar r = /=>/g;')).toEqual([]);
  });

  it("flags let, const, class, arrows, template strings and chained ternaries with lines", () => {
    const found = lintEs3("let a = 1;\nconst b = 2;\nvar f = (x) => x;\nvar t = `hi`;\nclass K {}\nvar c = a ? 1 : b ? 2 : 3;");
    expect(found.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(found[5].message).toMatch(/chained ternary/);
  });

  it("allows nested ternaries kept in their own parentheses or arguments", () => {
    expect(lintEs3("var x = f(a ? 1 : 2, b ? 3 : 4);")).toEqual([]);
  });

  it("treats / after return as a regex and / after ++ or an operand as division", () => {
    expect(lintEs3("function g(s) { return /[\"']/.test(s); }\nlet hidden = 1;").map((f) => f.line)).toEqual([2]);
    expect(lintEs3("var i = 0; var h = i++ / 2;\nlet x = 1;\nvar g = 4 / 2;").map((f) => f.line)).toEqual([2]);
    expect(lintEs3('function f(s) { return /^https?:\\/\\//.test(s) ? "url" : "x"; }')).toEqual([]);
    expect(lintEs3("var a = b / c / d;\nlet z = 1;").map((f) => f.line)).toEqual([2]);
  });
});

describe("skill files", () => {
  it("round-trips SKILL.md frontmatter and instructions", () => {
    const md = formatSkillMd({ name: "lower-third", description: "A lower\nthird.", mutates: false, args_example: '{"a":1}' }, "# Lower third\n\nUse it.");
    const { meta, body } = parseSkillMd(md);
    expect(meta).toEqual({ name: "lower-third", description: "A lower third.", mutates: "false", args: '{"a":1}' });
    expect(body).toBe("# Lower third\n\nUse it.");
    expect(parseSkillMd("no frontmatter").body).toBe("no frontmatter");
  });

  it("writes, lists, shadows and overwrites skills", () => {
    const project = tempDir("chroma-skill-proj-");
    const global = tempDir("chroma-skill-glob-");
    writeSkill(global, { name: "rig", description: "global rig", mutates: true }, "g", ["return 1;", "return 2;", "return 3;"], false);
    writeSkill(global, { name: "only-global", description: "g2", mutates: false }, "g2", ["return 0;"], false);
    writeSkill(project, { name: "rig", description: "project rig", mutates: true }, "p", ["return 9;"], false);
    const roots = [
      { scope: "project" as const, root: project },
      { scope: "global" as const, root: global },
    ];
    const all = listSkills(roots);
    expect(all.map((s) => `${s.scope}:${s.name}`)).toEqual(["project:rig", "global:only-global"]);
    expect(findSkill(roots, "rig")!.description).toBe("project rig");
    expect(findSkill([roots[1]], "rig")!.steps.map((s) => s.file)).toEqual(["1.jsx", "2.jsx", "3.jsx"]);
    expect(findSkill(roots, "only-global")!.mutates).toBe(false);

    expect(() => writeSkill(global, { name: "rig", description: "x", mutates: true }, "", ["return 1;"], false)).toThrow(/already exists/);
    const replaced = writeSkill(global, { name: "rig", description: "shorter", mutates: true }, "", ["return 1;"], true);
    expect(replaced.replaced).toBe(true);
    expect(fs.readdirSync(path.join(global, "rig")).sort()).toEqual(["1.jsx", "SKILL.md"]);
    expect(() => writeSkill(global, { name: "Bad Name", description: "x", mutates: true }, "", ["x"], false)).toThrow(/Bad skill name/);
  });

  it("uses the folder name as the skill's name, keeps args_example spacing, and clears stale steps", () => {
    const root = tempDir("chroma-skill-names-");
    writeSkill(root, { name: "lt", description: "d", mutates: true, args_example: '{"text":"A  B"}' }, "", ["return 1;"], false);
    fs.writeFileSync(path.join(root, "lt", "SKILL.md"), fs.readFileSync(path.join(root, "lt", "SKILL.md"), "utf8").replace("name: lt", "name: lower-third"));
    const [skill] = listSkills([{ scope: "global", root }]);
    expect(skill.name).toBe("lt");
    expect(skill.display_name).toBe("lower-third");
    expect(skill.args_example).toBe('{"text":"A  B"}');
    expect(findSkill([{ scope: "global", root }], "lower-third")).toBeNull();

    const stale = path.join(root, "old");
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, "5.jsx"), "return 5;\n");
    writeSkill(root, { name: "old", description: "d", mutates: true }, "", ["return 1;"], false);
    expect(fs.readdirSync(stale).sort()).toEqual(["1.jsx", "SKILL.md"]);
  });

  it("rejects Windows device names as skill names", () => {
    expect(() => writeSkill(tempDir("chroma-skill-dev-"), { name: "nul", description: "d", mutates: true }, "", ["x"], false)).toThrow(/Bad skill name/);
    expect(AeSkillRunSchema.safeParse({ name: "com1" }).success).toBe(false);
    expect(AeSkillRunSchema.safeParse({ name: "console" }).success).toBe(true);
  });

  it("lists a skill with an unreadable step, still shadowing a global one, and findSkill does not throw", () => {
    const project = tempDir("chroma-skill-bad-p-");
    const global = tempDir("chroma-skill-bad-g-");
    writeSkill(global, { name: "rig", description: "global", mutates: true }, "", ["return 1;"], false);
    writeSkill(project, { name: "rig", description: "project", mutates: true }, "", ["return 1;"], false);
    fs.writeFileSync(path.join(project, "rig", "1.jsx"), "x".repeat(MAX_STEP_BYTES + 1));
    const roots = [
      { scope: "project" as const, root: project },
      { scope: "global" as const, root: global },
    ];
    const all = listSkills(roots);
    expect(all).toHaveLength(1);
    expect(all[0].scope).toBe("project");
    expect(all[0].error).toMatch(/over 256 KB/);
    expect(findSkill(roots, "rig")!.error).toMatch(/over 256 KB/);
  });

  it("keeps the last 50 ae_run_jsx calls, newest first", () => {
    for (let i = 0; i < 55; i++) recordRunJsx({ op_id: `op${i}`, label: `l${i}`, code: `return ${i};`, mutates: false, at: "" });
    const recent = recentRunJsx();
    expect(recent).toHaveLength(50);
    expect(recent[0].op_id).toBe("op54");
    expect(recent[49].op_id).toBe("op5");
  });
});

describe("skill tools", () => {
  it("are registered, and ae_skill_run takes automatic checkpoints", () => {
    for (const name of ["ae_skill_list", "ae_skill_save", "ae_skill_run"]) expect(ALL_TOOLS.some((t) => t.name === name)).toBe(true);
    expect(AUTO_CHECKPOINT_TOOLS).toContain("ae_skill_run");
  });

  it("ae_run_jsx records its code so ae_skill_save can keep it by op_id", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx } = fakeAe(project, { runUserJsx: [7] });
    const runJsx = mutateTools.find((t) => t.name === "ae_run_jsx")!;
    const out: any = await runJsx.handler({ code: "return 7;", mutates: false, label: "seven" }, ctx);
    expect(out.op_id).toMatch(/^op_/);
    expect(out.result).toBe(7);

    const saved: any = await tool("ae_skill_save").handler(
      AeSkillSaveSchema.parse({ name: "seven", description: "Returns seven.", from_op_ids: [out.op_id], scope: "project", expect: { project_path: project } }),
      ctx
    );
    expect(saved.ok).toBe(true);
    expect(saved.mutates).toBe(false);
    expect(fs.readFileSync(path.join(path.dirname(project), "ae-skills", "seven", "1.jsx"), "utf8")).toBe("return 7;\n");

    const unknown: any = await tool("ae_skill_save").handler(
      AeSkillSaveSchema.parse({ name: "nope", description: "x", from_op_ids: ["op_missing"], scope: "global" }),
      ctx
    );
    expect(unknown.error).toBe("unknown_op_id");
  });

  it("ae_skill_save refuses non-ES3 steps and a project skill for another project", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx } = fakeAe(project, {});
    const bad: any = await tool("ae_skill_save").handler(
      AeSkillSaveSchema.parse({ name: "bad", description: "x", steps: ["let a = 1;"], scope: "global" }),
      ctx
    );
    expect(bad.error).toBe("not_es3");
    expect(bad.problems[0]).toMatch(/^1\.jsx line 1/);
    const other: any = await tool("ae_skill_save").handler(
      AeSkillSaveSchema.parse({ name: "ok", description: "x", steps: ["return 1;"], scope: "project", expect: { project_path: "C:/other/Other.aep" } }),
      ctx
    );
    expect(other.error).toBe("guard");
  });

  it("ae_skill_run runs every step in one guarded write with a separate read-back", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx, calls, dataDir } = fakeAe(project, {
      snapshotForReceipt: [{ comp_id: 1, layers: [] }, { comp_id: 1, layers: [{ name: "LT" }] }],
      runSkill: [{ steps_run: 2, results: [{ step: 1 }, { step: 2 }], value: "done" }],
    });
    writeSkill(path.join(dataDir, "skills"), { name: "lt", description: "Lower third.", mutates: true }, "", ["return 1;", "return prev + 1;"], false);

    const needsExpect: any = await tool("ae_skill_run").handler(AeSkillRunSchema.parse({ name: "lt" }), ctx);
    expect(needsExpect.error).toBe("needs_expect");

    const out: any = await tool("ae_skill_run").handler(
      AeSkillRunSchema.parse({ name: "lt", args: { text: "Ada" }, expect: { project_path: project, comp_id: 1 } }),
      ctx
    );
    expect(out.ok).toBe(true);
    expect(out.value).toBe("done");
    expect(out.receipt.matches).toBe(true);
    const fns = calls.map((c) => c.fn);
    expect(fns.slice(fns.indexOf("checkGuard"))).toEqual(["checkGuard", "snapshotForReceipt", "runSkill", "snapshotForReceipt"]);
    const run = calls.find((c) => c.fn === "runSkill")!.args;
    expect(run.mutates).toBe(true);
    expect(run.args).toEqual({ text: "Ada" });
    expect(run.steps.map((s: any) => s.code)).toEqual(["return 1;\n", "return prev + 1;\n"]);
    expect(run.expect.project_path).toBe(project);
  });

  it("ae_skill_run runs a read-only skill without a guard and refuses one edited into non-ES3", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx, calls, dataDir } = fakeAe(project, { runSkill: [{ steps_run: 1, results: [], value: 3 }] });
    const root = path.join(dataDir, "skills");
    writeSkill(root, { name: "count", description: "Counts.", mutates: false }, "", ["return 3;"], false);
    const out: any = await tool("ae_skill_run").handler(AeSkillRunSchema.parse({ name: "count" }), ctx);
    expect(out.value).toBe(3);
    expect(calls.some((c) => c.fn === "checkGuard")).toBe(false);

    fs.writeFileSync(path.join(root, "count", "1.jsx"), "const n = 3;\nreturn n;\n");
    const bad: any = await tool("ae_skill_run").handler(AeSkillRunSchema.parse({ name: "count" }), ctx);
    expect(bad.error).toBe("not_es3");
  });

  it("ae_skill_save refuses a step over the size limit in bytes, by name", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx } = fakeAe(project, {});
    const big = `var s = "${"字".repeat(100000)}";`;
    expect(big.length).toBeLessThan(200000);
    const out: any = await tool("ae_skill_save").handler(
      AeSkillSaveSchema.parse({ name: "big", description: "x", steps: ["return 1;", big], scope: "global" }),
      ctx
    );
    expect(out.error).toBe("step_too_large");
    expect(out.problems[0]).toMatch(/^2\.jsx is/);
  });

  it("ae_skill_run runs a skill that says it only reads guarded when expect is given, and reports an unreadable one", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx, calls, dataDir } = fakeAe(project, {
      snapshotForReceipt: [{ comp_id: 1, layers: [] }, { comp_id: 1, layers: [] }],
      runSkill: [{ steps_run: 1, results: [], value: 3 }],
    });
    const root = path.join(dataDir, "skills");
    writeSkill(root, { name: "count", description: "Counts.", mutates: false }, "", ["return 3;"], false);
    const out: any = await tool("ae_skill_run").handler(
      AeSkillRunSchema.parse({ name: "count", expect: { project_path: project, comp_id: 1 } }),
      ctx
    );
    expect(out.ok).toBe(true);
    expect(calls.some((c) => c.fn === "checkGuard")).toBe(true);
    const run = calls.find((c) => c.fn === "runSkill")!.args;
    expect(run.mutates).toBe(true);
    expect(run.expect.project_path).toBe(project);

    fs.writeFileSync(path.join(root, "count", "1.jsx"), "x".repeat(MAX_STEP_BYTES + 1));
    const bad: any = await tool("ae_skill_run").handler(AeSkillRunSchema.parse({ name: "count" }), ctx);
    expect(bad.error).toBe("unreadable_skill");
    const listed: any = await tool("ae_skill_list").handler({ name: "count" }, ctx);
    expect(listed.error).toBe("unreadable_skill");
  });
});

describe("ae_skill_run safety lint", () => {
  it("refuses a saved skill whose steps call a hard-limit member, and runs nothing", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx, calls, dataDir } = fakeAe(project, { runSkill: [{ steps_run: 1, results: [] }] });
    const root = path.join(dataDir, "skills");
    writeSkill(root, { name: "danger", description: "Edited later.", mutates: true }, "", ["return 1;"], false);
    fs.writeFileSync(path.join(root, "danger", "1.jsx"), "var f = new File('c:/x.txt');\nf.remove();\nreturn 1;\n");
    const out: any = await tool("ae_skill_run").handler(
      AeSkillRunSchema.parse({ name: "danger", expect: { project_path: project, comp_id: 1 } }),
      ctx
    );
    expect(out.ok).toBe(false);
    expect(out.error).toBe("unsafe_jsx");
    expect(out.message).toContain("Edit the skill");
    expect(out.problems[0]).toMatch(/^1\.jsx line 2: File\.remove/);
    expect(calls.map((c) => c.fn)).toEqual(["status"]);
  });

  it("refuses writes in a skill that says it only reads, unless expect makes it a guarded run", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx, dataDir } = fakeAe(project, { runSkill: [{ steps_run: 1, results: [] }], snapshotForReceipt: [{}, {}] });
    const root = path.join(dataDir, "skills");
    writeSkill(root, { name: "reader", description: "Reads.", mutates: false }, "", ["comp.layer(1).remove();\nreturn 1;"], false);
    const refused: any = await tool("ae_skill_run").handler(AeSkillRunSchema.parse({ name: "reader" }), ctx);
    expect(refused.error).toBe("unsafe_jsx");
    expect(refused.problems[0]).toContain("mutates: true");
    const guarded: any = await tool("ae_skill_run").handler(
      AeSkillRunSchema.parse({ name: "reader", expect: { project_path: project, comp_id: 1 } }),
      ctx
    );
    expect(guarded.ok).toBe(true);
  });

  it("ae_skill_save keeps a skill that only uses allowed members", async () => {
    const project = path.join(tempDir("chroma-skill-p-"), "Show.aep");
    const { ctx } = fakeAe(project, {});
    const out: any = await tool("ae_skill_save").handler(
      AeSkillSaveSchema.parse({
        name: "fine-skill",
        description: "Removes a layer and logs.",
        steps: ["$.writeln('x'); var l = comp.layer(1); l.remove(); return 1;"],
        scope: "global",
      }),
      ctx
    );
    expect(out.ok).toBe(true);
    const unsafe: any = await tool("ae_skill_save").handler(
      AeSkillSaveSchema.parse({ name: "bad-skill", description: "x", steps: ["system.callSystem('dir');"], scope: "global", overwrite: true }),
      ctx
    );
    expect(unsafe.error).toBe("unsafe_jsx");
    expect(unsafe.problems[0]).toContain("system.callSystem");
  });
});
