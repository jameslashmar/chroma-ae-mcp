import { describe, expect, it } from "vitest";
import { lintEs3 } from "../src/es3-lint.js";
import { mutateTools } from "../src/tools/mutate.js";

function fakeCtx() {
  const calls: string[] = [];
  const ctx: any = {
    bridge: {
      newOpId: () => "op1",
      callHost: async (fn: string) => {
        calls.push(`callHost:${fn}`);
        return { id: "x", result: { ok: 1 } };
      },
      evalRaw: async () => {
        calls.push("evalRaw");
        return { id: "x", result: {} };
      },
    },
    quarantine: { assertClear: () => {}, list: () => [] },
    queue: { run: async (_l: string, fn: () => Promise<unknown>) => { calls.push("queue"); return fn(); } },
  };
  return { ctx, calls };
}

const tool = mutateTools.find((t) => t.name === "ae_run_jsx")!;
const expectArg = { project_path: "<unsaved>" };

describe("lintEs3 for...of", () => {
  it("flags for...of, not an identifier named of or a string", () => {
    expect(lintEs3("for (var x of list) {}")[0].message).toMatch(/for\.\.\.of/);
    expect(lintEs3("for (const x of list) {}").some((f) => /for\.\.\.of/.test(f.message))).toBe(true);
    expect(lintEs3("for (var i = 0; i < of; i++) {}")).toEqual([]);
    expect(lintEs3("var s = 'for (x of y)'; // for (x of y)")).toEqual([]);
  });
});

describe("ae_run_jsx ES3 pre-check", () => {
  it("refuses let in a read before any call, with the line and the fix hint", async () => {
    const { ctx, calls } = fakeCtx();
    await expect(tool.handler({ code: "var a = 1;\nlet b = 2;\nreturn b;", mutates: false, label: "x" }, ctx)).rejects.toMatchObject({
      kind: "evalscript_error",
      line: 2,
      message: expect.stringMatching(/line 2: 'let' is not ES3[\s\S]*use var and function declarations/),
    });
    expect(calls).toEqual([]);
  });

  it("refuses arrow functions, template strings, class and for...of in a mutating call before the queue", async () => {
    for (const code of ["var f = (a) => a;", "var s = `x`;", "class A {}", "for (var x of y) {}", "const k = 1;"]) {
      const { ctx, calls } = fakeCtx();
      await expect(tool.handler({ code, mutates: true, label: "x", expect: expectArg }, ctx)).rejects.toThrow(/not ES3/);
      expect(calls).toEqual([]);
    }
  });

  it("is not triggered by strings or comments", async () => {
    const { ctx, calls } = fakeCtx();
    const code = "// let me const => class\nvar s = 'let x = `y` => z; class';\nvar r = /let|const/;\n/* for (a of b) */\nreturn s;";
    const res = await tool.handler({ code, mutates: false, label: "x" }, ctx);
    expect(res.result).toEqual({ ok: 1 });
    expect(calls).toEqual(["callHost:runUserJsx"]);
  });

  it("still runs a valid ES3 mutating script", async () => {
    const { ctx, calls } = fakeCtx();
    await tool.handler({ code: "var a = 1; function f(x) { return x + a; } return f(2);", mutates: true, label: "x", expect: expectArg }, ctx).catch(() => undefined);
    expect(calls).toContain("queue");
  });
});
