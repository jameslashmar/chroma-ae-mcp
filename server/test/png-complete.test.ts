/**
 * A frame AE is still writing: it can pause mid-file, so a size that held still is not enough; the
 * PNG must end with its IEND chunk (render.ts pngComplete, frames.ts decodePngFile).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { decodePngFile } from "../src/tools/ext/frames.js";
import { pngComplete, waitForFreshPng } from "../src/tools/render.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-png-"));
  dirs.push(d);
  return d;
};
function pngBytes(): Buffer {
  const img = new PNG({ width: 16, height: 16 });
  img.data.fill(200);
  return PNG.sync.write(img);
}

describe("pngComplete", () => {
  it("is false for a PNG cut short, true once its IEND is there, and does not judge other files", () => {
    const d = tmp();
    const full = pngBytes();
    const f = path.join(d, "a.png");
    fs.writeFileSync(f, full.subarray(0, full.length - 20));
    expect(pngComplete(f)).toBe(false);
    fs.writeFileSync(f, full);
    expect(pngComplete(f)).toBe(true);
    const other = path.join(d, "b.png");
    fs.writeFileSync(other, "not a png");
    expect(pngComplete(other)).toBe(true);
    expect(pngComplete(path.join(d, "missing.png"))).toBe(false);
  });

  it("waitForFreshPng keeps waiting while the size holds but the file is cut short", async () => {
    const d = tmp();
    const full = pngBytes();
    const f = path.join(d, "late.png");
    const start = Date.now() - 1000;
    fs.writeFileSync(f, full.subarray(0, full.length - 30));
    setTimeout(() => fs.writeFileSync(f, full), 120);
    const r = await waitForFreshPng(f, start, 2000, 20);
    expect(r.fresh).toBe(true);
    expect(r.size).toBe(full.length);
  });

  it("decodePngFile waits for the rest of the file, and names the cause when it never comes", () => {
    const d = tmp();
    const full = pngBytes();
    const f = path.join(d, "cut.png");
    fs.writeFileSync(f, full.subarray(0, full.length - 30));
    const t0 = Date.now();
    expect(() => decodePngFile(f)).toThrow(/not have finished writing/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    fs.writeFileSync(f, full);
    expect(decodePngFile(f).width).toBe(16);
  });
});
