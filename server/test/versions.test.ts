import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendVersionLog, findVersions, planVersion, versionLogPath, versionToken } from "../src/versions.js";

const tmpDirs: string[] = [];
function tree(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-versions-"));
  tmpDirs.push(root);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x");
  }
  return root;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("versionToken", () => {
  it("finds the last v<digits> that stands on its own", () => {
    expect(versionToken("shot010_comp_v003.mov")).toMatchObject({ number: 3, digits: 3, before: "shot010_comp_v", after: ".mov" });
    expect(versionToken("A_v2_final_v12.exr")?.number).toBe(12);
    expect(versionToken("logo.V7.png")?.number).toBe(7);
    expect(versionToken("dev010.mov")).toBeNull();
    expect(versionToken("render.mov")).toBeNull();
  });
});

describe("findVersions", () => {
  it("lists a movie's versions in its folder, oldest first", () => {
    const root = tree(["shot010_comp_v001.mov", "shot010_comp_v003.mov", "shot010_comp_v012.mov", "shot010_comp_v002.mp4", "shot020_comp_v009.mov"]);
    const r = findVersions(path.join(root, "shot010_comp_v003.mov"), false);
    expect(r.current).toBe(3);
    expect(r.versions.map((v) => v.version)).toEqual([1, 3, 12]);
  });

  it("picks the first frame of each version of a sequence in one folder", () => {
    const root = tree(["s_v001.0001.exr", "s_v001.0002.exr", "s_v002.0010.exr", "s_v002.0011.exr"]);
    const r = findVersions(path.join(root, "s_v001.0001.exr"), true);
    expect(r.versions.map((v) => [v.version, path.basename(v.path)])).toEqual([
      [1, "s_v001.0001.exr"],
      [2, "s_v002.0010.exr"],
    ]);
  });

  it("follows versioned folders for a sequence", () => {
    const root = tree(["shot_v001/shot_v001.0001.exr", "shot_v002/shot_v002.0001.exr", "shot_v002/shot_v002.0002.exr", "shot_v003/notes.txt"]);
    const r = findVersions(path.join(root, "shot_v001", "shot_v001.0001.exr"), true);
    expect(r.current).toBe(1);
    expect(r.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(path.basename(r.versions[1].path)).toBe("shot_v002.0001.exr");
  });

  it("finds nothing for an unversioned file", () => {
    const root = tree(["plate.mov"]);
    expect(findVersions(path.join(root, "plate.mov"), false)).toEqual({ current: null, versions: [] });
  });
});

describe("planVersion and the log", () => {
  it("targets the latest, or a requested version", () => {
    const root = tree(["a_v1.mov", "a_v2.mov", "a_v5.mov"]);
    const file = path.join(root, "a_v2.mov");
    expect(planVersion(file, false)).toMatchObject({ current: 2, latest: 5, newer: true, target: { version: 5 } });
    expect(planVersion(file, false, 1)).toMatchObject({ newer: true, target: { version: 1 } });
    expect(planVersion(path.join(root, "a_v5.mov"), false).newer).toBe(false);
    expect(planVersion(file, false, 9).target).toBeNull();
  });

  it("appends to <project>.versions.json next to the .aep", () => {
    const root = tree([]);
    const aep = path.join(root, "Job.aep");
    const entry = { at: "t", item_id: 1, name: "a", from: "a_v1.mov", to: "a_v2.mov", from_version: 1, to_version: 2 };
    appendVersionLog(aep, [entry]);
    const file = appendVersionLog(aep, [{ ...entry, to_version: 3 }]);
    expect(file).toBe(versionLogPath(aep));
    expect(path.basename(file)).toBe("Job.versions.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).entries.map((e: { to_version: number }) => e.to_version)).toEqual([2, 3]);
  });
});
