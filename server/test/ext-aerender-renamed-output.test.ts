import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRenamedOutput } from "../src/tools/ext/aerender.js";

// After Effects names a -comp render after its output module's format: on macOS the default
// module is H.264, so "smoke.avi" is written as "smoke.mp4" (seen live on AE 26.2.1, macOS).
describe("findRenamedOutput", () => {
  let dir: string;
  const started = Date.now() - 1000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "renamed-out-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds the file written under the format's extension", () => {
    fs.writeFileSync(path.join(dir, "smoke.mp4"), "x");
    expect(findRenamedOutput(path.join(dir, "smoke.avi"), started)).toBe(path.join(dir, "smoke.mp4"));
  });

  it("is null when the requested file exists", () => {
    fs.writeFileSync(path.join(dir, "smoke.avi"), "x");
    fs.writeFileSync(path.join(dir, "smoke.mp4"), "x");
    expect(findRenamedOutput(path.join(dir, "smoke.avi"), started)).toBeNull();
  });

  it("ignores a sibling older than the job", () => {
    const old = path.join(dir, "smoke.mp4");
    fs.writeFileSync(old, "x");
    const t = (started - 60_000) / 1000;
    fs.utimesSync(old, t, t);
    expect(findRenamedOutput(path.join(dir, "smoke.avi"), started)).toBeNull();
  });

  it("is null when more than one sibling could be it", () => {
    fs.writeFileSync(path.join(dir, "smoke.mp4"), "x");
    fs.writeFileSync(path.join(dir, "smoke.mov"), "x");
    expect(findRenamedOutput(path.join(dir, "smoke.avi"), started)).toBeNull();
  });

  it("does not match another name or a sequence pattern", () => {
    fs.writeFileSync(path.join(dir, "smoke_v2.mp4"), "x");
    fs.writeFileSync(path.join(dir, "smoke_00000.png"), "x");
    expect(findRenamedOutput(path.join(dir, "smoke.avi"), started)).toBeNull();
    expect(findRenamedOutput(path.join(dir, "smoke_[#####].tif"), started)).toBeNull();
  });

  it("is null when the folder is missing", () => {
    expect(findRenamedOutput(path.join(dir, "nope", "smoke.avi"), started)).toBeNull();
  });
});
