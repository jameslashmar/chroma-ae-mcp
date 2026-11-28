/**
 * ae_fonts check_files: the fonts behind After Effects' "Unknown BIB Error. cannot access font"
 * warnings (PR #19, AE 26.3). The host lists names and paths in steps; the server checks each file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import { AeFontsSchema, checkFontFiles, fontFileProblem, inventoryTools } from "../src/tools/ext/inventory.js";
import { FakeProject, loadHost } from "./support/fake-ae.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-fontfiles-"));
  dirs.push(d);
  return d;
}

/** A folder with a good TrueType file, a good OpenType file, an empty one and one that is not a font. */
function fontFolder() {
  const d = tmp();
  const good = path.join(d, "Good.ttf");
  fs.writeFileSync(good, Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(60)]));
  const otf = path.join(d, "Good.otf");
  fs.writeFileSync(otf, Buffer.concat([Buffer.from("OTTO"), Buffer.alloc(60)]));
  const empty = path.join(d, "Empty.ttf");
  fs.writeFileSync(empty, "");
  const junk = path.join(d, "Junk.otf");
  fs.writeFileSync(junk, "<html>404</html>");
  return { d, good, otf, empty, junk, missing: path.join(d, "Gone.ttf") };
}

describe("fontFileProblem", () => {
  it("passes good TrueType and OpenType files, and names what is wrong with the others", () => {
    const f = fontFolder();
    expect(fontFileProblem(f.good, false)).toBeNull();
    expect(fontFileProblem(f.otf, false)).toBeNull();
    expect(fontFileProblem(f.missing, false)).toMatchObject({ problem: "missing" });
    expect(fontFileProblem(f.empty, false)).toMatchObject({ problem: "empty" });
    expect(fontFileProblem(f.junk, false)).toMatchObject({ problem: "not_a_font", detail: expect.stringContaining("3c68746d") });
    expect(fontFileProblem(f.d, false)).toMatchObject({ problem: "not_a_file" });
    expect(fontFileProblem(null, false)).toMatchObject({ problem: "no_location" });
    // Adobe Fonts files are stored in Adobe's own form: only their presence is checked.
    expect(fontFileProblem(f.junk, true)).toBeNull();
  });
});

describe("inventory.jsx inventoryFontFiles", () => {
  it("lists names, paths and Adobe Fonts per font, and goes on in steps when time runs out", () => {
    const font = (ps: string, loc: string, adobe = false) => ({ postScriptName: ps, familyName: ps.split("-")[0], styleName: "Regular", location: loc, isFromAdobeFonts: adobe });
    const fonts = { allFonts: [[font("Arial-Regular", "C:/Windows/Fonts/arial.ttf"), font("Arial-Bold", "C:/Windows/Fonts/arialbd.ttf")], [font("Brand-Regular", "D:/fonts/brand.otf", true)]] };
    const { A, G } = loadHost(new FakeProject(), ["inventory.jsx"], { fonts });
    const r = A.inventoryFontFiles({});
    expect(r).toMatchObject({ available: true, scanned: 3, scan_truncated: false, next_family: null });
    expect(r.fonts[2]).toEqual({ postscript: "Brand-Regular", family: "Brand", style: "Regular", location: "D:/fonts/brand.otf", adobe: true });
    let t = 0;
    G.Date = class {
      getTime() {
        return (t += 3000);
      }
    };
    const s1 = A.inventoryFontFiles({});
    expect(s1).toMatchObject({ scanned: 2, scan_truncated: true, next_family: 1, next_font: 0 });
    const s2 = A.inventoryFontFiles({ start_family: 1, start_font: 0 });
    expect(s2.fonts.map((x: any) => x.postscript)).toEqual(["Brand-Regular"]);
  });
});

describe("ae_fonts check_files", () => {
  it("collects every step, checks each file once, and lists the broken fonts with how to fix them", async () => {
    const f = fontFolder();
    const steps = [
      { available: true, fonts: [{ postscript: "Good-A", family: "Good", style: "A", location: f.good, adobe: false }, { postscript: "Good-B", family: "Good", style: "B", location: f.good, adobe: false }], scan_truncated: true, next_family: 1, next_font: 0 },
      { available: true, fonts: [{ postscript: "Gone-Regular", family: "Gone", style: "Regular", location: f.missing, adobe: false }, { postscript: "Junk-Regular", family: "Junk", style: "Regular", location: f.junk, adobe: false }, { postscript: "Ok-Regular", family: "Ok", style: "Regular", location: f.otf, adobe: false }, { postscript: "Courier", family: "Courier", style: "Regular", location: null, adobe: false }], scan_truncated: false, next_family: null, next_font: null },
    ];
    const calls: Array<Record<string, unknown>> = [];
    const ctx = { bridge: { callHost: async (_fn: string, args: Record<string, unknown>) => ({ result: steps[calls.push(args) - 1] }) } } as unknown as ToolContext;
    const r: any = await checkFontFiles(ctx);
    expect(calls.map((c) => c.start_family)).toEqual([0, 1]);
    expect(r).toMatchObject({ available: true, fonts: 6, files: 4, problem_fonts: 2, problem_counts: { missing: 1, not_a_font: 1 }, scan_truncated: false, scan_calls: 2 });
    // A font AE gives no file for (a bitmap .fon font, a named instance of a variable font) is listed apart, not as a problem.
    expect(r.without_file).toMatchObject({ count: 1, fonts: ["Courier"] });
    expect(r.problems.map((p: any) => [p.postscript, p.problem])).toEqual([["Gone-Regular", "missing"], ["Junk-Regular", "not_a_font"]]);
    expect(r.note).toMatch(/Unknown BIB Error.*AdobeFnt\*\.lst/);
  });

  it("is an action of ae_fonts and reports an AE without app.fonts", async () => {
    expect(AeFontsSchema.safeParse({ action: "check_files" }).success).toBe(true);
    const ctx = { bridge: { callHost: async () => ({ result: { available: false, reason: "This After Effects has no app.fonts (it needs 24.0).", fonts: [] } }) } } as unknown as ToolContext;
    const r: any = await inventoryTools.find((t) => t.name === "ae_fonts")!.handler({ action: "check_files" }, ctx);
    expect(r).toMatchObject({ available: false, action: "check_files", reason: expect.stringMatching(/24\.0/) });
  });
});
