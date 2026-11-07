/**
 * Guard against the vitest 2.1.9 module-id race. A test that fetches a src module under a second id
 * (importOriginal in a relative vi.mock factory, or a relative vi.importActual) can make the forks
 * pool serve a half-written module. Use vi.importActual("/src/...ts") instead. The race cannot be
 * reproduced on demand, so this check is the regression test.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Built from pieces so this file does not contain the patterns it looks for.
const MOCK = "vi" + ".mock";
const ACTUAL = "vi" + ".importActual";
const ORIGINAL = "importOri" + "ginal";

/** Problems found in one source text; empty when it is clean. */
function findProblems(text: string): string[] {
  const problems: string[] = [];
  const relMock = new RegExp(escape(MOCK) + "\\(\\s*[\"'`]\\.{1,2}/", "g");
  let m: RegExpExecArray | null;
  while ((m = relMock.exec(text)) !== null) {
    // The factory is whatever follows up to the next top-level vi.mock or the end of the text.
    const rest = text.slice(m.index + m[0].length);
    const next = rest.indexOf(MOCK + "(");
    const body = next === -1 ? rest : rest.slice(0, next);
    if (body.indexOf(ORIGINAL) !== -1) problems.push("relative mock with an importOriginal factory");
  }
  const relActual = new RegExp(escape(ACTUAL) + "(<[^>]*>)?\\(\\s*[\"'`]\\.{1,2}/");
  if (relActual.test(text)) problems.push("relative importActual");
  return problems;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("test module ids", () => {
  it("flags the bad forms and passes the good ones", () => {
    const badMock = `${MOCK}("../src/a.js", async (${ORIGINAL}) => { const r = await ${ORIGINAL}(); return r; });`;
    const badActual = `await ${ACTUAL}<typeof import("../src/a.js")>("../src/a.js");`;
    const good = `${MOCK}("../src/a.js", async () => { const r = await ${ACTUAL}("/src/a.ts"); return r; });`;
    const builtin = `${MOCK}("node:fs", async (${ORIGINAL}) => { const r = await ${ORIGINAL}(); return r; });`;
    expect(findProblems(badMock)).toEqual(["relative mock with an importOriginal factory"]);
    expect(findProblems(badActual)).toEqual(["relative importActual"]);
    expect(findProblems(good)).toEqual([]);
    expect(findProblems(builtin)).toEqual([]);
  });

  it("no test file fetches a src module under a second id", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const bad: string[] = [];
    for (const file of listTs(dir)) {
      const problems = findProblems(fs.readFileSync(file, "utf8"));
      for (const p of problems) bad.push(`${path.relative(dir, file)}: ${p}`);
    }
    expect(bad).toEqual([]);
  });
});
