import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as vm from "node:vm";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const lintScript = path.join(repoRoot, "scripts", "lint-jsx.mjs");
const require = createRequire(import.meta.url);

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function lint(source: string): { status: number | null; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-lint-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "case.jsx");
  fs.writeFileSync(file, source, "utf8");
  const r = spawnSync(process.execPath, [lintScript, file], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("lint-jsx: ES3 reserved words", () => {
  const bad: Array<[string, string, string]> = [
    ["var short = 1;", "short", "variable name"],
    ["var a = 1, final = 2;", "final", "variable name"],
    ["function char(x) { return x; }", "char", "function name"],
    ["function f(int, y) { return y; }", "int", "parameter name"],
    ["var f = function (a, default) { return a; };", "default", "parameter name"],
    ["try { f(); } catch (class) { }", "class", "catch variable name"],
    ["var counts = { move: 0, delete: 0 };", "delete", "object-literal key"],
    ["var o = {\n  final: 1\n};", "final", "object-literal key"],
    ["var o = { boolean: true };", "boolean", "object-literal key"],
    ["var n = obj.final;", "final", "after a dot"],
    ["var n = obj.item.default;", "default", "after a dot"],
    ["obj.delete(1);", "delete", "after a dot"],
  ];
  for (const [code, word, kind] of bad) {
    it(`fails on ${kind}: ${code.split("\n")[0]}`, () => {
      const r = lint(code);
      expect(r.status).toBe(1);
      expect(r.out).toContain(`reserved word '${word}'`);
      expect(r.out).toContain(kind);
    });
  }

  const good: string[] = [
    'var counts = { move: 0, "delete": 0 }; counts["delete"] += 1;',
    'var d = obj["default"]; var s = obj["short"];',
    "var shortSide = 1; var finalValue = 2;",
    "switch (x) {\n  case 1: break;\n  default: y = 2;\n}",
    "var o = { a: c ? 1 : null, b: true, d: false };",
    "var t = x ? true : false; delete o.k; for (var i = 0; i < 3; i++) { }",
    "// var short = 1; obj.delete()\nvar s = 'var short; { delete: 1 }';",
    "var x = typeof y; var z = new Foo(); if (a instanceof B) { }",
  ];
  for (const code of good) {
    it(`passes: ${code.split("\n")[0]}`, () => {
      const r = lint(code);
      expect(r.out).toContain("JSX Lint Passed");
      expect(r.status).toBe(0);
    });
  }

  it("catches the two defects that broke captions.jsx and projectitems.jsx in After Effects", () => {
    const a = lint("    var s = args.style || {};\n    var short = Math.min(comp.width, comp.height);\n");
    expect(a.status).toBe(1);
    expect(a.out).toContain("case.jsx:2: ES3 reserved word 'short'");
    const b = lint("  function planSummary(P, args) {\n    var counts = { create_folder: 0, move: 0, rename: 0, label: 0, comment: 0, delete: 0 };\n  }\n");
    expect(b.status).toBe(1);
    expect(b.out).toContain("case.jsx:2: ES3 reserved word 'delete'");
  });

  it("leaves the shipped host files clean", () => {
    const r = spawnSync(process.execPath, [lintScript], { encoding: "utf8", cwd: repoRoot });
    expect(r.stdout + r.stderr).toContain("0 issues");
    expect(r.status).toBe(0);
  });
});

describe("service boot script: one bad ext file does not stop the others", () => {
  const common = require(path.join(repoRoot, "panel", "client", "common.js")) as {
    buildBootScript: (core: string, extDir: string, files: string[]) => string;
    parseBootResult: (raw: string) => null | { aeVersion: string; failures: Array<{ file: string; line: number | null; message: string }> };
  };

  function runBoot(files: string[], failing: Record<string, { line?: number; message: string }>, coreLoads = true) {
    const loaded: string[] = [];
    const sandbox: Record<string, unknown> = {
      app: { version: "26.0x68" },
      $: {
        evalFile(p: string) {
          const base = path.basename(p);
          if (base === "core.jsx") {
            if (coreLoads) sandbox.__chromaAe = {};
            return;
          }
          if (failing[base]) {
            const e = new Error(failing[base].message) as Error & { line?: number };
            e.line = failing[base].line;
            throw e;
          }
          loaded.push(base);
        },
      },
    };
    const script = common.buildBootScript("C:/ext/host/core.jsx", "C:/ext/host/ext", files);
    // The script is ES3 text. node:vm shows only that it is valid JS, but it exercises the control flow.
    const raw = vm.runInNewContext(script, sandbox) as string;
    return { raw, loaded };
  }

  it("is plain ES3 text (no let/const/arrows/template strings, no JSON)", () => {
    const script = common.buildBootScript("C:/ext/host/core.jsx", "C:/ext/host/ext", ["a.jsx", "b.jsx"]);
    expect(script).not.toMatch(/\b(let|const|class)\b|=>|`|JSON\./);
  });

  it("loads every ext file when none fail and returns the plain ok result", () => {
    const { raw, loaded } = runBoot(["a.jsx", "b.jsx", "c.jsx"], {});
    expect(raw).toBe("26.0x68|ok");
    expect(loaded).toEqual(["a.jsx", "b.jsx", "c.jsx"]);
    expect(common.parseBootResult(raw)).toEqual({ aeVersion: "26.0x68", failures: [] });
  });

  it("keeps loading the files after a bad one and reports file, line and message", () => {
    const { raw, loaded } = runBoot(
      ["a.jsx", "captions.jsx", "projectitems.jsx", "z.jsx"],
      {
        "captions.jsx": { line: 885, message: "Illegal use of reserved word" },
        "projectitems.jsx": { line: 1365, message: "Illegal use of\nreserved word" },
      }
    );
    expect(loaded).toEqual(["a.jsx", "z.jsx"]);
    const parsed = common.parseBootResult(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.aeVersion).toBe("26.0x68");
    expect(parsed!.failures).toEqual([
      { file: "captions.jsx", line: 885, message: "Illegal use of reserved word" },
      { file: "projectitems.jsx", line: 1365, message: "Illegal use of reserved word" },
    ]);
  });

  it("still resolves with a failure that has no line number", () => {
    const { raw } = runBoot(["a.jsx"], { "a.jsx": { message: "boom" } });
    expect(common.parseBootResult(raw)!.failures).toEqual([{ file: "a.jsx", line: null, message: "boom" }]);
  });

  it("reports 'missing' (not ok) when core did not load", () => {
    const { raw } = runBoot(["a.jsx"], {}, false);
    expect(raw).toBe("missing");
    expect(common.parseBootResult(raw)).toBeNull();
    expect(common.parseBootResult("EvalScript error.")).toBeNull();
  });
});
