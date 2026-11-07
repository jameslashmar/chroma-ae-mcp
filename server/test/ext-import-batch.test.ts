/**
 * Batch import with interpretation (ae_import_assets: paths, target_folder_id,
 * interpret, rules, max_seconds) and many-item interpretation
 * (ae_set_footage_interpretation: item_ids, overrides, strict).
 *
 * Host code runs under node:vm against test/support/fake-ae.ts; the tools run
 * against a fake bridge. Nothing here touches After Effects.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidatesFromPaths,
  globToRegExp,
  resolveInterpret,
  ruleName,
  scanAssets,
  shapeImportResult,
  type AssetCandidate,
  type ImportRule,
} from "../src/assets.js";
import { PanelHost } from "../src/panel-host.js";
import { QuarantineStore } from "../src/quarantine.js";
import { SingleWriterQueue } from "../src/queue.js";
import { SettingsStore } from "../src/settings.js";
import type { ToolContext } from "../src/tools/common.js";
import { AeImportAssetsSchema, AssetWatcher, assetsTools } from "../src/tools/ext/assets.js";
import { AeSetFootageInterpretationSchema, InterpretSettingsSchema, interpretTools, mergeInterpret } from "../src/tools/ext/interpret.js";
import { FakeFootage, FakeProject, FileSource, GUARD, ImportOptions, loadHost } from "./support/fake-ae.js";

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  ImportOptions.refuse = [];
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function touch(file: string, content = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const AlphaMode = { IGNORE: 1, STRAIGHT: 2, PREMULTIPLIED: 3 };
const FieldSeparationType = { OFF: 10, UPPER_FIELD_FIRST: 11, LOWER_FIELD_FIRST: 12 };
const PulldownPhase = { OFF: 20, WSSWW: 26 };
const PulldownMethod = { PULLDOWN_3_2: 40, ADVANCE_24P: 41 };
const ImportAsType = { FOOTAGE: 70 };

/** A footage source that follows the Interpret Footage rules the host depends on. */
class Src extends FileSource {
  writes: string[] = [];
  hasAlpha = true;
  isStill = false;
  alphaMode = AlphaMode.STRAIGHT;
  invertAlpha = false;
  nativeFrameRate = 25;
  loop = 1;
  failOn: string | null = null;
  /** After the first write of this name, every further one throws (a restore that cannot be done). */
  blockAfter: string | null = null;
  private seenWrites: Record<string, number> = {};
  file: { fsName: string } | null = null;
  private fs = FieldSeparationType.OFF;
  private pd = PulldownPhase.OFF;
  private conform = 0;
  private note(what: string) {
    this.seenWrites[what] = (this.seenWrites[what] ?? 0) + 1;
    if (this.blockAfter === what && this.seenWrites[what] > 1) throw new Error(`blocked write of ${what}`);
    this.writes.push(what);
    if (this.failOn === what) {
      this.failOn = null;
      throw new Error(`forced failure at ${what}`);
    }
  }
  get fieldSeparationType() {
    if (this.isStill) throw new Error("Not valid for a still");
    return this.fs;
  }
  set fieldSeparationType(v: number) {
    this.note("fieldSeparationType");
    this.fs = v;
  }
  get removePulldown() {
    return this.pd;
  }
  set removePulldown(v: number) {
    this.note("removePulldown");
    this.pd = v;
  }
  get conformFrameRate() {
    if (this.isStill) throw new Error("Not valid for a still");
    return this.conform;
  }
  set conformFrameRate(v: number) {
    this.note("conformFrameRate");
    this.conform = v;
  }
  get displayFrameRate() {
    return this.conform || this.nativeFrameRate;
  }
}

class Footage extends FakeFootage {
  hasVideo = true;
  pixelAspect = 1;
  useProxy = false;
  proxySource: unknown = null;
}

/** An object that throws on any use once its parentFolder was assigned, as AE's returned item can. */
function staleAfterMove<T extends object>(item: T): T {
  let moved = false;
  const dead = () => new Error("Object is invalid");
  return new Proxy(item, {
    get(t, k) {
      if (moved) throw dead();
      return Reflect.get(t, k, t);
    },
    set(t, k, v) {
      if (moved) throw dead();
      const ok = Reflect.set(t, k, v, t);
      if (k === "parentFolder") moved = true;
      return ok;
    },
  });
}

function scene(opts: { stale?: boolean } = {}) {
  const project = new FakeProject();
  const clock = { t: 1_000_000, step: 0 };
  const returned: object[] = [];
  const imports: Array<{ name: string; sequence: boolean; alphabetical: boolean }> = [];
  const sources = new Map<string, Src>();
  let advanceAfter = Infinity;
  let advanceBy = 0;
  (project as any).importFile = (io: ImportOptions) => {
    const full = io.file.fsName;
    const name = path.basename(full);
    imports.push({ name, sequence: io.sequence, alphabetical: io.forceAlphabetical });
    if (name.includes("boom")) throw new Error("damaged frame");
    const src = new Src();
    src.hasAlpha = !name.includes("noalpha");
    src.isStill = name.includes("still");
    src.file = { fsName: full };
    sources.set(name, src);
    const item = new Footage(name, 100, 100, src);
    item.project = project;
    item.parentFolder = project.rootFolder;
    item.file = { fsName: full };
    project.all.push(item);
    if (imports.length === advanceAfter) clock.t += advanceBy;
    const back = opts.stale === false ? item : staleAfterMove(item);
    returned.push(back);
    return back;
  };
  const host = loadHost(project, ["assets.jsx", "interpret.jsx"]);
  const before = new Set(Object.keys(host.G));
  host.G.Date = function () {
    // Every reading can move the clock on, to model a slow import (step 0: it only moves when a test says so).
    return { getTime: () => (clock.t += clock.step) };
  };
  Object.assign(host.G, { AlphaMode, FieldSeparationType, PulldownPhase, PulldownMethod, ImportAsType });
  const known = new Set([...before, "Date", "AlphaMode", "FieldSeparationType", "PulldownPhase", "PulldownMethod", "ImportAsType"]);
  return {
    project,
    imports,
    sources,
    clock,
    returned,
    leaks: () => Object.keys(host.G).filter((k) => !known.has(k)),
    jumpAfter(n: number, ms: number) {
      advanceAfter = n;
      advanceBy = ms;
    },
    ...host,
  };
}

function footageOf(project: FakeProject, name: string): Footage {
  return project.all.find((i) => i instanceof FakeFootage && i.name === name) as Footage;
}

function addFootage(project: FakeProject, name: string, mutate: (s: Src) => void = () => {}): Footage {
  const src = new Src();
  mutate(src);
  const item = new Footage(name, 100, 100, src);
  item.project = project;
  item.parentFolder = project.rootFolder;
  project.all.push(item);
  return item;
}

// ---------- pure: schemas, rules, shaping, scan ----------

describe("many-item interpretation schema", () => {
  const parse = (v: object) => AeSetFootageInterpretationSchema.safeParse({ expect: GUARD, ...v });

  it("takes item_id or item_ids, never both or neither", () => {
    expect(parse({ item_id: 1, loop: 2 }).success).toBe(true);
    expect(parse({ item_ids: [1, 2], loop: 2 }).success).toBe(true);
    expect(parse({ item_id: 1, item_ids: [1, 2], loop: 2 }).success).toBe(false);
    expect(parse({ loop: 2 }).success).toBe(false);
    expect(parse({ item_ids: [], loop: 2 }).success).toBe(false);
  });

  it("keeps overrides and strict for the many-item form, and the ids of overrides inside item_ids", () => {
    expect(parse({ item_id: 1, loop: 2, strict: true }).success).toBe(false);
    expect(parse({ item_id: 1, loop: 2, overrides: [{ item_id: 1, loop: 3 }] }).success).toBe(false);
    expect(parse({ item_ids: [1, 2], loop: 2, overrides: [{ item_id: 2, loop: 3 }] }).success).toBe(true);
    expect(parse({ item_ids: [1, 2], loop: 2, overrides: [{ item_id: 9, loop: 3 }] }).success).toBe(false);
    expect(parse({ item_ids: [1, 2], loop: 2, overrides: [{ item_id: 2 }] }).success).toBe(false);
    expect(parse({ item_ids: [1, 1], loop: 2 }).success).toBe(false);
  });

  it("needs a setting for every item, from the shared ones or an override", () => {
    expect(parse({ item_ids: [1, 2] }).success).toBe(false);
    expect(parse({ item_ids: [1, 2], overrides: [{ item_id: 1, loop: 2 }] }).success).toBe(false);
    expect(parse({ item_ids: [1, 2], overrides: [{ item_id: 1, loop: 2 }, { item_id: 2, loop: 3 }] }).success).toBe(true);
  });

  it("keeps a pulldown guess alone, also after an override is merged in", () => {
    expect(parse({ item_ids: [1, 2], pulldown: "guess_3_2" }).success).toBe(true);
    expect(parse({ item_ids: [1, 2], pulldown: "guess_3_2", overrides: [{ item_id: 2, conform_frame_rate: 24 }] }).success).toBe(false);
  });

  it("merges an override over the shared settings field by field, alpha replaced whole", () => {
    const merged = mergeInterpret({ alpha: { mode: "straight", invert: true }, loop: 2 }, { alpha: { mode: "ignore" }, pixel_aspect: 1 });
    expect(merged).toEqual({ alpha: { mode: "ignore" }, loop: 2, pixel_aspect: 1 });
  });

  it("InterpretSettingsSchema rejects unknown keys and an empty object", () => {
    expect(InterpretSettingsSchema.safeParse({ loop: 2 }).success).toBe(true);
    expect(InterpretSettingsSchema.safeParse({}).success).toBe(false);
    expect(InterpretSettingsSchema.safeParse({ loop: 2, colour_profile: "sRGB" }).success).toBe(false);
  });
});

describe("import schema", () => {
  it("refuses watch with bin or max_seconds, and paths with recursive, instead of ignoring them", () => {
    const exp = { project_path: "C:/p.aep" };
    expect(AeImportAssetsSchema.safeParse({ watch: true, bin: "X", expect: exp }).success).toBe(false);
    expect(AeImportAssetsSchema.safeParse({ watch: true, max_seconds: 10, expect: exp }).success).toBe(false);
    expect(AeImportAssetsSchema.safeParse({ paths: ["C:/a.png"], recursive: false, expect: exp }).success).toBe(false);
    expect(AeImportAssetsSchema.safeParse({ watch: true, expect: exp }).success).toBe(true);
    expect(AeImportAssetsSchema.safeParse({ bin: "X", max_seconds: 10, recursive: false, expect: exp }).success).toBe(true);
    expect(AeImportAssetsSchema.safeParse({ paths: ["C:/a.png"], bin: "X", expect: exp }).success).toBe(true);
  });

  const parse = (v: object) => AeImportAssetsSchema.safeParse({ expect: { project_path: "<unsaved>" }, ...v });
  it("ties the new arguments together", () => {
    expect(parse({ paths: ["C:/a/b.mov"], interpret: { alpha: { mode: "straight" } } }).success).toBe(true);
    expect(parse({ paths: ["C:/a/b.mov"], folder: "C:/a" }).success).toBe(false);
    expect(parse({ paths: ["C:/a/b.mov"], watch: true }).success).toBe(false);
    expect(parse({ bin: "X", target_folder_id: 4 }).success).toBe(false);
    expect(parse({ target_folder_id: 4 }).success).toBe(true);
    expect(parse({ watch: true, interpret: { loop: 2 } }).success).toBe(false);
    expect(parse({ allow_writing: true }).success).toBe(false);
    expect(parse({ max_seconds: 3 }).success).toBe(false);
    expect(parse({ max_seconds: 111 }).success).toBe(false);
    expect(parse({ interpret: { alpha: { mode: "straigth" } } }).success).toBe(false);
    expect(parse({ rules: [{ match: { name_glob: "x*" }, interpret: { colour: 1 } }] }).success).toBe(false);
  });
});

describe("interpretation rules", () => {
  const c = (p: string, sequence: boolean, subfolder: string[] = []) => ({ path: p, sequence, subfolder });
  const rules: ImportRule[] = [
    { match: { sequence: true, ext: ["exr"] }, interpret: { conform_frame_rate: 25 } },
    { match: { name_glob: "shot_*" }, interpret: { conform_frame_rate: 30, loop: 2 } },
    { match: { subfolder_glob: "mattes/*" }, interpret: { alpha: { mode: "straight" } } },
  ];

  it("a sequence is matched by its name without the frame number", () => {
    expect(ruleName(c("C:/r/shot_0001.exr", true))).toBe("shot_.exr");
    expect(ruleName(c("C:/r/shot_0001.exr", false))).toBe("shot_0001.exr");
    expect(globToRegExp("shot_*").test("shot_.exr")).toBe(true);
    expect(globToRegExp("SHOT_?.EXR").test("shot_a.exr")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("the first matching rule wins per field over the shared settings", () => {
    const seq = resolveInterpret(c("C:/r/shot_0001.exr", true), { loop: 5, pixel_aspect: 1 }, rules);
    // rule 1 sets conform (25), rule 2 would set 30 but rule 1 came first; rule 2's loop replaces the shared one.
    expect(seq).toEqual({ loop: 2, pixel_aspect: 1, conform_frame_rate: 25 });
    const still = resolveInterpret(c("C:/r/mattes/m.png", false, ["mattes", "a"]), undefined, rules);
    expect(still).toEqual({ alpha: { mode: "straight" } });
    expect(resolveInterpret(c("C:/r/other.mov", false), undefined, rules)).toBeUndefined();
    expect(resolveInterpret(c("C:/r/other.mov", false), { loop: 3 }, rules)).toEqual({ loop: 3 });
  });
});

describe("shapeImportResult", () => {
  it("caps the lists at 100 rows with totals and counts what happened", () => {
    const imported = Array.from({ length: 300 }, (_, i) => ({
      path: `C:/f/${i}.png`,
      interpretation: i % 3 === 0 ? { applied: ["loop"], skipped: [{ field: "alpha", reason: "no alpha channel" }] } : { applied: [], skipped: [] },
    }));
    const failed = [
      ...Array.from({ length: 120 }, (_, i) => ({ path: `C:/g/${i}.png`, stage: "import", error: "bad" })),
      { path: "C:/f/0.png", stage: "interpret", error: "x" },
    ];
    const out = shapeImportResult({ requested: 421, imported, failed, skipped_existing: 4, still_writing: 2, not_attempted: 7 });
    expect(out.imported).toHaveLength(100);
    expect(out.imported_total).toBe(300);
    expect(out.imported_truncated).toBe(true);
    expect(out.failed).toHaveLength(100);
    expect(out.failed_total).toBe(121);
    expect(out.summary).toEqual({
      requested: 421,
      imported: 300,
      failed: 120,
      skipped_existing: 4,
      still_writing: 2,
      not_attempted: 7,
      interpretation_applied: 100,
      interpretation_skipped: 100,
      interpretation_failed: 1,
    });
  });
});

describe("scanning", () => {
  it("counts a sequence as one candidate: thousands of frames never hit the limit", () => {
    const root = tempDir("chroma-scan-");
    for (let i = 1; i <= 120; i++) touch(path.join(root, `s_${String(i).padStart(4, "0")}.png`));
    touch(path.join(root, "logo.png"));
    const stats = { files_seen: 0, truncated: false };
    const found = scanAssets(root, { maxFiles: 150, stats });
    expect(stats).toMatchObject({ files_seen: 121, truncated: false });
    expect(found.map((c) => [path.basename(c.path), c.sequence, c.frames ?? 1, c.incomplete])).toEqual([["logo.png", false, 1, undefined], ["s_0001.png", true, 120, undefined]]);
  });

  it("past the file limit it marks the cut folders incomplete and leaves the rest whole", () => {
    const root = tempDir("chroma-scan-");
    for (let i = 0; i < 4; i++) touch(path.join(root, "a", `a${i}.png`));
    for (let i = 0; i < 4; i++) touch(path.join(root, "b", `b${i}.png`));
    touch(path.join(root, "top.png"));
    const stats: { files_seen: number; truncated: boolean; incomplete_dirs?: string[] } = { files_seen: 0, truncated: false };
    const found = scanAssets(root, { maxFiles: 6, stats });
    // a is read whole (4 files), b is cut after 2, and top.png comes after: b and the top folder are incomplete.
    expect(stats.truncated).toBe(true);
    expect(stats.files_seen).toBe(9);
    expect(stats.incomplete_dirs).toEqual(["b", ""]);
    expect(found.filter((c) => !c.incomplete).map((c) => c.subfolder.join("/"))).toEqual(["a", "a", "a", "a"]);
    expect(found.filter((c) => c.incomplete).map((c) => path.basename(c.path)).sort()).toEqual(["b0.png", "b1.png"]);
  });

  it("reports the first and last frame of a sequence", () => {
    const root = tempDir("chroma-scan-");
    for (const n of [3, 4, 5, 9]) touch(path.join(root, `s_${String(n).padStart(4, "0")}.exr`));
    const [seq] = scanAssets(root);
    expect(seq).toMatchObject({ sequence: true, frames: 4, firstFrame: 3, lastFrame: 9 });
  });

  it("an explicit list gets the scan's sequence rule, finds the first frame, and reports missing files", () => {
    const root = tempDir("chroma-paths-");
    for (let i = 1; i <= 3; i++) touch(path.join(root, "a", `p_${String(i).padStart(3, "0")}.png`));
    touch(path.join(root, "a", "pair_001.png"));
    touch(path.join(root, "a", "pair_002.png"));
    touch(path.join(root, "m.mov"));
    touch(path.join(root, "notes.txt"));
    const { candidates, missing } = candidatesFromPaths(
      [path.join(root, "a", "p_002.png"), path.join(root, "a", "p_001.png"), path.join(root, "a", "pair_001.png"), path.join(root, "m.mov"), path.join(root, "nope.mov"), path.join(root, "notes.txt")],
      { root }
    );
    expect(candidates.map((x) => [path.basename(x.path), x.sequence, x.frames ?? 1, x.subfolder.join("/")])).toEqual([
      ["p_001.png", true, 3, "a"],
      ["pair_001.png", false, 1, "a"],
      ["m.mov", false, 1, ""],
    ]);
    expect(candidates[0].given).toBe(path.join(root, "a", "p_002.png"));
    expect(missing.map((m) => [path.basename(m.path), m.error])).toEqual([
      ["nope.mov", "file not found"],
      ["notes.txt", ".txt is not a type this tool imports"],
    ]);
    expect(candidatesFromPaths([path.join(root, "a", "p_001.png")], { sequences: false }).candidates[0].sequence).toBe(false);
  });
});

// ---------- host: interpretBatch ----------

describe("interpret.jsx: interpretBatch", () => {
  function batchScene() {
    const s = scene();
    const a = addFootage(s.project, "a.mov");
    const b = addFootage(s.project, "noalpha.mov", (x) => (x.hasAlpha = false));
    const c = addFootage(s.project, "c.mov");
    return { ...s, a, b, c };
  }
  const items = (ids: number[], extra: object) => ids.map((id) => ({ item_id: id, ...extra }));

  it("strict: one item that can't take its settings refuses the whole call and opens no undo group", () => {
    const { A, undo, a, b, c } = batchScene();
    const r = A.interpretBatch({ items: items([a.id, b.id, c.id], { alpha: { mode: "ignore" } }), strict: true, expect: GUARD });
    expect(r.refused).toBe(true);
    expect(r.no_op).toBe(true);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]).toMatchObject({ item_id: b.id, name: "noalpha.mov" });
    expect(r.rejected[0].reason).toMatch(/no alpha channel/);
    expect(undo.begun).toBe(0);
    expect((a.mainSource as Src).alphaMode).toBe(AlphaMode.STRAIGHT);
    expect((c.mainSource as Src).alphaMode).toBe(AlphaMode.STRAIGHT);
  });

  it("strict: false writes the items that can take it, lists the rest, in one undo group", () => {
    const { A, undo, a, b, c } = batchScene();
    const r = A.interpretBatch({ items: items([a.id, b.id, c.id], { alpha: { mode: "ignore" } }), strict: false, expect: GUARD });
    expect(r.refused).toBe(false);
    expect(r.changed_items.map((x: any) => x.item_id)).toEqual([a.id, c.id]);
    expect(r.rejected.map((x: any) => x.item_id)).toEqual([b.id]);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
    expect((a.mainSource as Src).alphaMode).toBe(AlphaMode.IGNORE);
    expect((c.mainSource as Src).alphaMode).toBe(AlphaMode.IGNORE);
  });

  it("a write that throws on one item puts that item back, lists it, and the others stay, in one undo group", () => {
    const { A, undo, a, b, c, leaks } = batchScene();
    (b.mainSource as Src).hasAlpha = true;
    (b.mainSource as Src).failOn = "conformFrameRate";
    const r = A.interpretBatch({ items: items([a.id, b.id, c.id], { alpha: { mode: "ignore" }, conform_frame_rate: 24 }), strict: true, expect: GUARD });
    expect(r.refused).toBe(false);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ item_id: b.id });
    expect(r.failed[0].message).toMatch(/old interpretation was put back/);
    expect(r.changed_items.map((x: any) => x.item_id)).toEqual([a.id, c.id]);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
    expect((b.mainSource as Src).alphaMode).toBe(AlphaMode.STRAIGHT);
    expect((b.mainSource as Src).conformFrameRate).toBe(0);
    expect((a.mainSource as Src).conformFrameRate).toBe(24);
    expect((c.mainSource as Src).conformFrameRate).toBe(24);
    // Nothing leaked into the global scope on the failure path.
    expect(leaks()).toEqual([]);
  });

  it("reports an item that is already as asked without an undo group, and a duplicate or unknown item as rejected", () => {
    const { A, undo, a } = batchScene();
    const same = A.interpretBatch({ items: items([a.id], { alpha: { mode: "straight" } }), expect: GUARD });
    expect(same.no_op).toBe(true);
    expect(same.no_change_items).toHaveLength(1);
    expect(undo.begun).toBe(0);
    const bad = A.interpretBatch({ items: [{ item_id: a.id, loop: 2 }, { item_id: a.id, loop: 3 }, { item_id: 99999, loop: 2 }], strict: false, expect: GUARD });
    expect(bad.rejected.map((x: any) => x.reason)).toEqual(["Item " + a.id + " is listed twice", "No footage item with id 99999"]);
    expect(bad.changed_items.map((x: any) => x.item_id)).toEqual([a.id]);
  });

  it("refuses a wrong guard and more than 200 items before anything is touched", () => {
    const { A, undo, a } = batchScene();
    expect(() => A.interpretBatch({ items: items([a.id], { loop: 2 }), expect: { project_path: "C:/other.aep" } })).toThrow(/guard/i);
    expect(() => A.interpretBatch({ items: items(Array.from({ length: 201 }, (_, i) => i + 1), { loop: 2 }), expect: GUARD })).toThrow(/At most 200/);
    expect(undo.begun).toBe(0);
  });

  it("interpretCheckSettings catches typos and ranges without an item", () => {
    const { A } = batchScene();
    expect(() => A.interpretCheckSettings({ alpha: { mode: "straigth" } })).toThrow(/Unknown alpha mode/);
    expect(() => A.interpretCheckSettings({ colour_profile: "sRGB" })).toThrow(/Unknown interpretation setting/);
    expect(() => A.interpretCheckSettings({ loop: 0 })).toThrow(/loop/);
    expect(() => A.interpretCheckSettings({ pulldown: "guess_3_2", conform_frame_rate: 24 })).toThrow(/alone/);
    expect(() => A.interpretCheckSettings({})).toThrow(/no setting/);
    expect(A.interpretCheckSettings({ alpha: { mode: "premultiplied", premul_color: [0, 0, 0] }, conform_frame_rate: 25 }).ok).toBe(true);
  });

  it("interpretApplicable drops what an item can't take and says why", () => {
    const { A, a, b } = batchScene();
    const still = addFootage(scene().project, "s.png", (x) => (x.isStill = true));
    const settings = { alpha: { mode: "ignore" }, conform_frame_rate: 25, loop: 2, pixel_aspect: 1 };
    expect(A.interpretApplicable(a, settings).skipped).toEqual([]);
    expect(A.interpretApplicable(b, settings).skipped).toEqual([{ field: "alpha", reason: "no alpha channel" }]);
    const s = A.interpretApplicable(still, settings);
    expect(Object.keys(s.use).sort()).toEqual(["alpha", "pixel_aspect"]);
    expect(s.skipped.map((x: any) => [x.field, x.reason])).toEqual([["conform_frame_rate", "a still"], ["loop", "a still"]]);
    a.footageMissing = true;
    expect(A.interpretApplicable(a, settings).skipped.map((x: any) => x.reason)).toEqual(["missing file", "missing file", "missing file", "missing file"]);
  });
});

// ---------- host: importAssets ----------

describe("assets.jsx: importAssets", () => {
  const dir = () => tempDir("chroma-import-");
  const files = (root: string, names: string[]) => names.map((n) => {
    touch(path.join(root, n));
    return { path: path.join(root, n).replace(/\\/g, "/"), subfolder: [] as string[], sequence: false };
  });

  it("imports with interpretation in ONE undo group, skips what an item can't take, and uses the item it looks up again", () => {
    const root = dir();
    const { A, undo, project, sources, leaks } = scene();
    const items = files(root, ["a.mov", "noalpha.mov", "still.png", "d.mov"]).map((it) => ({ ...it, interpret: { alpha: { mode: "ignore" }, conform_frame_rate: 25 } }));
    const r = A.importAssets({ expect: GUARD, bin: "_Assets", items });
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
    expect(r.failed).toEqual([]);
    expect(r.imported).toHaveLength(4);
    const by = (n: string) => r.imported.find((i: any) => i.name === n);
    expect(by("a.mov").interpretation).toMatchObject({ applied: ["alpha_mode", "conform_frame_rate"], skipped: [] });
    expect(by("noalpha.mov").interpretation).toMatchObject({ applied: ["conform_frame_rate"] });
    expect(by("noalpha.mov").interpretation.skipped).toEqual([{ field: "alpha", reason: "no alpha channel" }]);
    expect(by("still.png").interpretation.applied).toEqual(["alpha_mode"]);
    expect(by("still.png").interpretation.skipped).toEqual([{ field: "conform_frame_rate", reason: "a still" }]);
    for (const n of ["a.mov", "d.mov"]) {
      expect(sources.get(n)!.alphaMode).toBe(AlphaMode.IGNORE);
      expect(sources.get(n)!.conformFrameRate).toBe(25);
    }
    // They were moved into the bin.
    const bin = project.rootFolder.children.find((c: any) => c.name === "_Assets");
    expect(bin.children).toHaveLength(4);
    expect(leaks()).toEqual([]);
  });

  it("hands the interpretation the item found again by id, never the object importFile returned", () => {
    const root = dir();
    const { A, sources, returned, project } = scene();
    const seen: unknown[] = [];
    const real = A.interpretApplicable;
    A.interpretApplicable = (item: unknown, settings: unknown) => {
      seen.push(item);
      return real(item, settings);
    };
    const items = files(root, ["a.mov"]).map((it) => ({ ...it, interpret: { conform_frame_rate: 25 } }));
    const r = A.importAssets({ expect: GUARD, bin: "_Assets", items });
    expect(returned.length).toBe(1);
    expect(seen).toHaveLength(1);
    expect(Object.is(seen[0], returned[0])).toBe(false);
    expect(Object.is(seen[0], project.itemByID(r.imported[0].item_id))).toBe(true);
    expect(sources.get("a.mov")!.conformFrameRate).toBe(25);
    // The returned object really is dead after the move: touching it throws, so a build that kept it could not have written.
    expect(() => (returned[0] as any).name).toThrow(/Object is invalid/);
  });

  it("imports without interpretation exactly as before and numbers sequences with force-alphabetical off", () => {
    const root = dir();
    const { A, imports } = scene();
    const items = files(root, ["x_0001.exr", "y.mov"]);
    items[0].sequence = true;
    const r = A.importAssets({ expect: GUARD, bin: "_Assets", items });
    expect(r.imported.map((i: any) => i.interpretation)).toEqual([undefined, undefined]);
    // The fake starts with force-alphabetical ON: only a script that turns it off gets numbered order.
    expect(imports[0]).toEqual({ name: "x_0001.exr", sequence: true, alphabetical: false });
    expect(imports[1]).toMatchObject({ name: "y.mov", sequence: false });
  });

  it("a file AE refuses and a file that throws are listed with their stage; the rest imports, in one undo group", () => {
    const root = dir();
    ImportOptions.refuse = ["refused"];
    const { A, undo } = scene();
    const items = files(root, ["ok1.mov", "refused.mov", "boom.mov", "ok2.mov"]);
    items.push({ path: path.join(root, "gone.mov").replace(/\\/g, "/"), subfolder: [], sequence: false });
    const r = A.importAssets({ expect: GUARD, bin: "_Assets", items });
    expect(r.imported.map((i: any) => i.name)).toEqual(["ok1.mov", "ok2.mov"]);
    expect(r.failed.map((f: any) => [path.basename(f.path), f.stage, f.error])).toEqual([
      ["refused.mov", "import", "AE can't import this as footage"],
      ["boom.mov", "import", "damaged frame"],
      ["gone.mov", "import", "file not found"],
    ]);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
  });

  it("an interpretation that throws leaves the item imported with the error, and a failed row with stage interpret", () => {
    const root = dir();
    const { A, undo, sources, project } = scene();
    const items = files(root, ["a.mov", "b.mov"]).map((it) => ({ ...it, interpret: { conform_frame_rate: 25 } }));
    // The second file's source fails its conform write.
    const real = (project as any).importFile;
    (project as any).importFile = (io: ImportOptions) => {
      const item = real(io);
      if (io.file.fsName.endsWith("b.mov")) sources.get("b.mov")!.failOn = "conformFrameRate";
      return item;
    };
    const r = A.importAssets({ expect: GUARD, bin: "_Assets", items });
    expect(r.imported).toHaveLength(2);
    expect(r.imported[1].interpretation.error).toMatch(/forced failure/);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ stage: "interpret", item_id: r.imported[1].item_id });
    expect(sources.get("b.mov")!.conformFrameRate).toBe(0);
    expect(undo).toMatchObject({ begun: 1, ended: 1 });
  });

  it("stops between files at the time budget, lists the rest (20 paths at most), and always imports the first", () => {
    const root = dir();
    const { A, jumpAfter, imports } = scene();
    const names = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, "0")}.mov`);
    const items = files(root, names);
    jumpAfter(2, 100_000);
    const r = A.importAssets({ expect: GUARD, bin: "_Assets", items, max_seconds: 30 });
    expect(r.imported).toHaveLength(2);
    expect(imports).toHaveLength(2);
    expect(r.not_attempted).toBe(23);
    expect(r.not_attempted_paths).toHaveLength(20);
    expect(r.not_attempted_paths[0]).toMatch(/f02\.mov$/);
    // A budget already spent still does one file.
    const again = scene();
    again.jumpAfter(0, 0);
    again.clock.t += 0;
    const r2 = again.A.importAssets({ expect: GUARD, bin: "_Assets", items: items.slice(0, 3), max_seconds: 5 });
    expect(r2.imported.length).toBeGreaterThanOrEqual(1);
  });

  it("checks every argument before the group: a typo in interpret, a bad folder id, a bad budget", () => {
    const root = dir();
    const { A, undo, project } = scene();
    const items = files(root, ["a.mov"]);
    const start = project.numItems;
    expect(() => A.importAssets({ expect: GUARD, bin: "_Assets", items: items.map((i) => ({ ...i, interpret: { alpha: { mode: "straigth" } } })) })).toThrow(/Unknown alpha mode/);
    expect(() => A.importAssets({ expect: GUARD, target_folder_id: 424242, items })).toThrow(/No project folder/);
    expect(() => A.importAssets({ expect: GUARD, bin: "_Assets", items, max_seconds: 3 })).toThrow(/max_seconds/);
    expect(() => A.importAssets({ expect: GUARD, bin: "_Assets", items: Array.from({ length: 201 }, () => items[0]) })).toThrow(/At most 200/);
    expect(() => A.importAssets({ expect: { project_path: "C:/other.aep" }, bin: "_Assets", items })).toThrow(/guard/i);
    expect(undo.begun).toBe(0);
    expect(project.numItems).toBe(start);
  });

  it("imports into a folder by id, mirroring subfolders under it, and reads that folder back", () => {
    const root = dir();
    const { A, project } = scene();
    const target = project.addFolder("Plates");
    const items = files(root, ["a.mov"]).map((i) => ({ ...i, subfolder: ["day1"] }));
    const r = A.importAssets({ expect: GUARD, target_folder_id: target.id, items });
    expect(r.folder_id).toBe(target.id);
    const back = A.assetBinContents({ folder_id: target.id });
    expect(back.items.map((i: any) => [i.name, i.bin])).toEqual([["a.mov", "Plates/day1/"]]);
    expect(project.rootFolder.children.some((c: any) => c.name === "_Assets")).toBe(false);
  });
});

// ---------- tools with a fake bridge ----------

function fakeBridge(handlers: Record<string, (args: any) => unknown>, project = "<unsaved>") {
  const calls: Array<{ fn: string; args: any }> = [];
  const dataDir = tempDir("chroma-batch-data-");
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      if (fn === "checkGuard") return { ok: true, result: { ok: true, project_path: project, comp_is_valid: true }, durationMs: 1 };
      if (fn === "status") return { ok: true, result: { project_path: project }, durationMs: 1 };
      const h = handlers[fn];
      if (!h) throw new Error(`Unexpected script: ${script}`);
      return { ok: true, result: h(args), durationMs: 1 };
    },
    queue,
    quarantine,
  });
  const settings = new SettingsStore(path.join(dataDir, "settings.json"));
  const ctx: ToolContext = { bridge: host, queue, quarantine, settings, dataDir };
  return { ctx, calls };
}

const setTool = interpretTools.find((t) => t.name === "ae_set_footage_interpretation")!;
const clip = (id: number, extra: object = {}) => ({ id, name: `clip${id}.mov`, kind: "file", has_alpha: true, alpha_mode: "straight", invert_alpha: false, field_separation: "off", remove_pulldown: "off", conform_frame_rate: 0, native_frame_rate: 25, loop: 1, pixel_aspect: 1, use_proxy: false, proxy: null, ...extra });

describe("ae_set_footage_interpretation with item_ids", () => {
  it("sends the merged settings once, reads before and after in separate calls, and presents a bounded summary", async () => {
    const ids = [1, 2, 3];
    const { ctx, calls } = fakeBridge({
      interpretBatch: (a) => (a.plan_only ? { refused: false, no_op: true, rejected: [], changed_items: [], no_change_items: [] } : { refused: false, rejected: [], failed: [], changed_items: ids.map((id) => ({ item_id: id, name: `clip${id}.mov`, changed: ["conform_frame_rate"] })), no_change_items: [] }),
      interpretRead: (() => {
        let n = 0;
        return () => ({ items: ids.map((id) => clip(id, n++ < 3 ? {} : { conform_frame_rate: id === 3 ? 30 : 24 })) });
      })(),
    });
    const args = AeSetFootageInterpretationSchema.parse({ item_ids: ids, conform_frame_rate: 24, overrides: [{ item_id: 3, conform_frame_rate: 30 }], expect: GUARD });
    const out: any = await setTool.handler(args, ctx);
    expect(calls.map((c) => c.fn)).toEqual(["interpretBatch", "checkGuard", "interpretRead", "interpretBatch", "interpretRead"]);
    expect(calls[0].args.plan_only).toBe(true);
    expect(calls[3].args.items).toEqual([
      { item_id: 1, conform_frame_rate: 24 },
      { item_id: 2, conform_frame_rate: 24 },
      { item_id: 3, conform_frame_rate: 30 },
    ]);
    expect(out.applied).toBe(true);
    expect(out.summary).toEqual({ requested: 3, changed: 3, no_change: 0, rejected: 0, failed: 0 });
    expect(out.receipt.matches).toBe(true);
  });

  it("strict refusal writes nothing and takes no guard, read or checkpoint call", async () => {
    const { ctx, calls } = fakeBridge({
      interpretBatch: () => ({ refused: true, no_op: true, rejected: [{ item_id: 2, name: "b.mov", reason: "no alpha channel" }], changed_items: [], no_change_items: [] }),
    });
    const args = AeSetFootageInterpretationSchema.parse({ item_ids: [1, 2], alpha: { mode: "ignore" }, expect: GUARD });
    const out: any = await setTool.handler(args, ctx);
    expect(out).toMatchObject({ ok: false, error: "interpretation_rejected", applied: false });
    expect(out.rejected).toEqual([{ item_id: 2, name: "b.mov", reason: "no alpha channel" }]);
    expect(calls.map((c) => c.fn)).toEqual(["interpretBatch"]);
  });

  it("strict: false skips the plan call and reports rejected and failed items", async () => {
    const { ctx, calls } = fakeBridge({
      interpretBatch: () => ({
        refused: false,
        rejected: [{ item_id: 2, reason: "no alpha channel" }],
        failed: [{ item_id: 3, name: "c.mov", message: "forced (put back)" }],
        changed_items: [{ item_id: 1, name: "clip1.mov", changed: ["alpha_mode"] }],
        no_change_items: [],
      }),
      interpretRead: () => ({ items: [clip(1, { alpha_mode: "ignore" }), clip(2), clip(3)] }),
    });
    const args = AeSetFootageInterpretationSchema.parse({ item_ids: [1, 2, 3], alpha: { mode: "ignore" }, strict: false, expect: GUARD });
    const out: any = await setTool.handler(args, ctx);
    expect(calls.filter((c) => c.fn === "interpretBatch")).toHaveLength(1);
    expect(out.summary).toEqual({ requested: 3, changed: 1, no_change: 0, rejected: 1, failed: 1 });
    expect(out.rejected[0].item_id).toBe(2);
    expect(out.failed[0].item_id).toBe(3);
  });

  it("puts a setting that did not stick into the receipt, per item, and caps the list", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const { ctx } = fakeBridge({
      interpretBatch: () => ({ refused: false, rejected: [], failed: [], changed_items: ids.map((id) => ({ item_id: id, name: `clip${id}.mov`, changed: ["conform_frame_rate"] })), no_change_items: [] }),
      interpretRead: () => ({ items: ids.map((id) => clip(id)) }),
    });
    const args = AeSetFootageInterpretationSchema.parse({ item_ids: ids, conform_frame_rate: 24, strict: false, expect: GUARD });
    const out: any = await setTool.handler(args, ctx);
    expect(out.receipt.matches).toBe(false);
    const paths = out.receipt.mismatches.map((m: any) => m.path);
    expect(paths[0]).toBe("items[1].conform_frame_rate");
    expect(out.receipt.mismatches.length).toBeLessThanOrEqual(51);
    expect(out.items).toHaveLength(100);
    expect(out.items_truncated).toBe(true);
  });
});

describe("ae_import_assets: interpretation, paths and refusals", () => {
  const importTool = assetsTools[0];

  function importBridge(projectPath: string, state: { footage: string[] }, opts: { interpretReadItems?: (ids: number[]) => unknown[] } = {}) {
    return fakeBridge(
      {
        footagePaths: () => ({ project_path: projectPath, paths: state.footage }),
        importAssets: (a) => {
          const imported = a.items.map((it: any, i: number) => ({
            path: it.path,
            item_id: 100 + i,
            name: path.basename(it.path),
            type: "Footage",
            sequence: it.sequence,
            ...(it.interpret ? { interpretation: { applied: Object.keys(it.interpret), skipped: [], use: it.interpret } } : {}),
          }));
          state.footage.push(...imported.map((i: any) => i.path));
          return { bin_id: 1, folder_id: a.target_folder_id ?? 1, imported, failed: [], not_attempted: 0, not_attempted_paths: [] };
        },
        assetBinContents: () => ({ items: state.footage.map((p, i) => ({ item_id: i, bin: "_Assets/", name: path.basename(p), path: p })) }),
        interpretRead: (a) => ({ items: opts.interpretReadItems ? opts.interpretReadItems(a.item_ids) : a.item_ids.map((id: number) => clip(id, { conform_frame_rate: 25 })) }),
      },
      projectPath
    );
  }

  it("imports an explicit list with shared settings and rules, resolves them per file in Node, and reads each setting back", async () => {
    const root = tempDir("chroma-imp-");
    for (let i = 1; i <= 3; i++) touch(path.join(root, "r", `shot_${String(i).padStart(4, "0")}.exr`));
    touch(path.join(root, "m.mov"));
    const project = path.join(root, "Show.aep");
    const state = { footage: [] as string[] };
    const { ctx, calls } = importBridge(project, state);
    const args = AeImportAssetsSchema.parse({
      paths: [path.join(root, "r", "shot_0001.exr"), path.join(root, "m.mov")],
      interpret: { conform_frame_rate: 25 },
      rules: [{ match: { sequence: true }, interpret: { loop: 2 } }],
      allow_writing: true,
      target_folder_id: 77,
      max_seconds: 20,
      expect: { project_path: project },
    });
    const out: any = await importTool.handler(args, ctx);
    const write = calls.find((c) => c.fn === "importAssets")!.args;
    expect(write.target_folder_id).toBe(77);
    expect(write.max_seconds).toBe(20);
    expect(write.items.map((i: any) => [path.basename(i.path), i.sequence, i.interpret])).toEqual([
      ["shot_0001.exr", true, { conform_frame_rate: 25, loop: 2 }],
      ["m.mov", false, { conform_frame_rate: 25 }],
    ]);
    expect(calls.find((c) => c.fn === "assetBinContents")!.args.folder_id).toBe(77);
    // Both bin reads (before and after) ask for the imported files only, never the whole bin.
    const binReads = calls.filter((c) => c.fn === "assetBinContents");
    expect(binReads).toHaveLength(2);
    for (const r of binReads) expect(r.args.only_paths.map((p: string) => path.basename(p)).sort()).toEqual(["m.mov", "shot_0001.exr"]);
    expect(out.summary).toMatchObject({ requested: 2, imported: 2, failed: 0, interpretation_applied: 2 });
    expect(out.imported[0].interpretation.use).toBeUndefined();
    expect(out.imported.find((i: any) => i.sequence).frames).toBe(3);
    expect(calls.map((c) => c.fn).slice(-2)).toEqual(["assetBinContents", "interpretRead"]);
    // loop 2 was applied but the read-back says loop 1: the receipt shows it.
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.some((m: any) => m.path.endsWith(".loop"))).toBe(true);
  });

  it("a dry run shows the interpretation each file would get and sends no write", async () => {
    const root = tempDir("chroma-imp-");
    touch(path.join(root, "_assets", "a.mov"));
    touch(path.join(root, "_assets", "b.png"));
    const project = path.join(root, "Show.aep");
    const { ctx, calls } = importBridge(project, { footage: [] });
    await new Promise((r) => setTimeout(r, 2100));
    const args = AeImportAssetsSchema.parse({
      dry_run: true,
      interpret: { loop: 3 },
      rules: [{ match: { ext: ["png"] }, interpret: { alpha: { mode: "premultiplied" } } }],
      expect: { project_path: project },
    });
    const out: any = await importTool.handler(args, ctx);
    expect(out.dry_run).toBe(true);
    expect(out.to_import.map((r: any) => [r.path.split("/").pop(), r.interpret])).toEqual([
      ["a.mov", { loop: 3 }],
      ["b.png", { loop: 3, alpha: { mode: "premultiplied" } }],
    ]);
    expect(calls.some((c) => c.fn === "importAssets" || c.fn === "interpretRead")).toBe(false);
  }, 15_000);

  it("refuses settings that don't fit together for one file, before anything is written", async () => {
    const root = tempDir("chroma-imp-");
    touch(path.join(root, "a.mov"));
    const project = path.join(root, "Show.aep");
    const { ctx, calls } = importBridge(project, { footage: [] });
    const args = AeImportAssetsSchema.parse({
      paths: [path.join(root, "a.mov")],
      allow_writing: true,
      interpret: { conform_frame_rate: 25 },
      rules: [{ match: {}, interpret: { pulldown: "guess_3_2" } }],
      expect: { project_path: project },
    });
    const out: any = await importTool.handler(args, ctx);
    expect(out).toMatchObject({ ok: false, error: "bad_args" });
    expect(out.message).toMatch(/alone/);
    expect(calls.some((c) => c.fn === "importAssets")).toBe(false);
  });

  it("reports files in paths that do not exist as scan failures and imports the rest", async () => {
    const root = tempDir("chroma-imp-");
    touch(path.join(root, "a.mov"));
    const project = path.join(root, "Show.aep");
    const { ctx } = importBridge(project, { footage: [] });
    const args = AeImportAssetsSchema.parse({ paths: [path.join(root, "a.mov"), path.join(root, "gone.mov")], allow_writing: true, expect: { project_path: project } });
    const out: any = await importTool.handler(args, ctx);
    expect(out.summary).toMatchObject({ requested: 2, imported: 1, failed: 1 });
    expect(out.failed[0]).toMatchObject({ stage: "scan", error: "file not found" });
  });

  it("says what stopped at the time budget and how to continue", async () => {
    const root = tempDir("chroma-imp-");
    touch(path.join(root, "a.mov"));
    touch(path.join(root, "b.mov"));
    const project = path.join(root, "Show.aep");
    const { ctx } = fakeBridge(
      {
        footagePaths: () => ({ project_path: project, paths: [] }),
        importAssets: (a) => ({ bin_id: 1, imported: [{ path: a.items[0].path, item_id: 1, name: "a.mov", type: "Footage", sequence: false }], failed: [], not_attempted: 1, not_attempted_paths: [a.items[1].path] }),
        assetBinContents: () => ({ items: [{ item_id: 1, bin: "_Assets/", name: "a.mov", path: path.join(root, "a.mov").replace(/\\/g, "/") }] }),
      },
      project
    );
    const args = AeImportAssetsSchema.parse({ paths: [path.join(root, "a.mov"), path.join(root, "b.mov")], allow_writing: true, expect: { project_path: project } });
    const out: any = await importTool.handler(args, ctx);
    expect(out.not_attempted).toBe(1);
    expect(out.not_attempted_paths).toHaveLength(1);
    expect(out.message).toMatch(/Call again/);
    expect(out.summary.not_attempted).toBe(1);
  });

  it("a 5001-frame sequence that is already in the project does not stop a new logo, in the tool and in the watcher", async () => {
    const root = tempDir("chroma-big-");
    const assets = path.join(root, "_assets");
    fs.mkdirSync(assets);
    for (let i = 1; i <= 5001; i++) fs.writeFileSync(path.join(assets, `shot_${String(i).padStart(5, "0")}.exr`), "");
    fs.writeFileSync(path.join(assets, "logo.png"), "");
    const project = path.join(root, "Show.aep");
    const first = path.join(assets, "shot_00001.exr");
    const state = { footage: [first] };
    const { ctx, calls } = importBridge(project, state);
    await new Promise((r) => setTimeout(r, 2100));
    const out: any = await importTool.handler(AeImportAssetsSchema.parse({ expect: { project_path: project } }), ctx);
    expect(out.ok).toBe(true);
    expect(out.scan_truncated).toBeUndefined();
    expect(out.imported.map((i: any) => i.name)).toEqual(["logo.png"]);
    expect(out.already_in_project).toBe(1);
    expect(calls.filter((c) => c.fn === "importAssets")[0].args.items.map((i: any) => path.basename(i.path))).toEqual(["logo.png"]);

    // The watcher does the same with the next new file.
    fs.writeFileSync(path.join(assets, "second.png"), "");
    ctx.settings!.updateAssetWatch({ enabled: true, since: new Date(Date.now() - 3_600_000).toISOString() });
    await new Promise((r) => setTimeout(r, 2100));
    const logs: string[] = [];
    const watcher = new AssetWatcher(ctx, { log: (_l, m) => logs.push(m) });
    expect(await watcher.tick()).toEqual({ imported: 1, failed: 0 });
    expect(calls.filter((c) => c.fn === "importAssets")[1].args.items.map((i: any) => path.basename(i.path))).toEqual(["second.png"]);
  }, 40_000);

  it("more than 200 new candidates are refused with advice that fits: a subfolder or paths", async () => {
    const root = tempDir("chroma-many-");
    const assets = path.join(root, "_assets");
    fs.mkdirSync(assets);
    for (let i = 0; i < 201; i++) fs.writeFileSync(path.join(assets, `n${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}.png`), "");
    const project = path.join(root, "Show.aep");
    const { ctx, calls } = importBridge(project, { footage: [] });
    await new Promise((r) => setTimeout(r, 2100));
    const out: any = await importTool.handler(AeImportAssetsSchema.parse({ expect: { project_path: project } }), ctx);
    expect(out).toMatchObject({ ok: false, error: "too_many" });
    expect(out.message).toMatch(/subfolder as .folder., or paths/);
    expect(calls.some((c) => c.fn === "importAssets")).toBe(false);
    // The watcher takes 200 and logs that the rest waits.
    ctx.settings!.updateAssetWatch({ enabled: true, since: new Date(Date.now() - 3_600_000).toISOString() });
    const logs: string[] = [];
    const watcher = new AssetWatcher(ctx, { log: (_l, m) => logs.push(m) });
    expect(await watcher.tick()).toEqual({ imported: 200, failed: 0 });
    expect(logs.join("\n")).toMatch(/1 more new file\(s\) wait for the next look/);
  }, 40_000);

  it("the watcher logs files left at the host's time budget instead of dropping them", async () => {
    const root = tempDir("chroma-budget-");
    const assets = path.join(root, "_assets");
    fs.mkdirSync(assets);
    touch(path.join(assets, "a.png"));
    touch(path.join(assets, "b.png"));
    const project = path.join(root, "Show.aep");
    const { ctx } = fakeBridge(
      {
        footagePaths: () => ({ project_path: project, paths: [] }),
        importAssets: (a) => ({ bin_id: 1, imported: [{ path: a.items[0].path, item_id: 1, name: "a.png", type: "Footage", sequence: false }], failed: [], not_attempted: 1, not_attempted_paths: [a.items[1].path] }),
        assetBinContents: () => ({ items: [] }),
      },
      project
    );
    await new Promise((r) => setTimeout(r, 2100));
    ctx.settings!.updateAssetWatch({ enabled: true, since: new Date(Date.now() - 3_600_000).toISOString() });
    const logs: string[] = [];
    const watcher = new AssetWatcher(ctx, { log: (_l, m) => logs.push(m) });
    await watcher.tick();
    expect(logs.join("\n")).toMatch(/stopped at the host's time budget: 1 file\(s\) wait for the next look/);
  }, 15_000);
});

// ---------- keep the imports honest ----------

describe("fixtures", () => {
  it("AssetCandidate keeps the fields the tool fills", () => {
    const c: AssetCandidate = { path: "x", subfolder: [], sequence: false, mtimeMs: 0, arrivedMs: 0, interpret: { loop: 2 } };
    expect(c.interpret).toEqual({ loop: 2 });
  });
});

// ---------- repair round ----------

/** A bridge that runs the real host code (the interpret and assets files of `scene`). */
function hostBridge(A: any) {
  const calls: Array<{ fn: string; args: any }> = [];
  const dataDir = tempDir("chroma-hostbridge-");
  const queue = new SingleWriterQueue();
  const quarantine = new QuarantineStore(path.join(dataDir, "quarantine.json"));
  const host = new PanelHost({
    evalScript: async (script) => {
      const fn = script.slice("__chromaAe.".length, script.indexOf("("));
      const args = JSON.parse(script.slice(script.indexOf("(") + 1, script.lastIndexOf(")")));
      calls.push({ fn, args });
      try {
        return { ok: true, result: JSON.parse(JSON.stringify(A[fn](args))), durationMs: 1 };
      } catch (e) {
        return { ok: false, error: A.formatError(e), durationMs: 1 };
      }
    },
    queue,
    quarantine,
  });
  const ctx: ToolContext = { bridge: host, queue, quarantine, dataDir };
  return { ctx, calls };
}

describe("import: the budget, the in-lease recheck, the bin read-back", () => {
  it("always imports the first file, even when every clock reading is already past the budget", () => {
    const root = tempDir("chroma-first-");
    const s = scene();
    s.clock.step = 100_000;
    const items = ["a.mov", "b.mov", "c.mov"].map((n) => {
      touch(path.join(root, n));
      return { path: path.join(root, n).replace(/\\/g, "/"), subfolder: [] as string[], sequence: false };
    });
    const r = s.A.importAssets({ expect: GUARD, bin: "_Assets", items, max_seconds: 5 });
    expect(r.imported.map((i: any) => i.name)).toEqual(["a.mov"]);
    expect(r.not_attempted).toBe(2);
  });

  it("looks at the project's footage again inside the lease and drops what another import brought in meanwhile", async () => {
    const root = tempDir("chroma-recheck-");
    touch(path.join(root, "a.mov"));
    touch(path.join(root, "b.mov"));
    const project = path.join(root, "Show.aep");
    const a = path.join(root, "a.mov");
    let reads = 0;
    const written: string[][] = [];
    const { ctx } = fakeBridge(
      {
        // The first read (the tool's) sees an empty project; the one inside the lease sees a.mov, imported by someone else.
        footagePaths: () => ({ project_path: project, paths: ++reads === 1 ? [] : [a] }),
        importAssets: (args) => {
          written.push(args.items.map((i: any) => path.basename(i.path)));
          return { bin_id: 1, imported: args.items.map((i: any, n: number) => ({ path: i.path, item_id: n + 1, name: path.basename(i.path), type: "Footage", sequence: false })), failed: [], not_attempted: 0, not_attempted_paths: [] };
        },
        assetBinContents: () => ({ items: [] }),
      },
      project
    );
    const args = AeImportAssetsSchema.parse({ paths: [a, path.join(root, "b.mov")], allow_writing: true, expect: { project_path: project } });
    await assetsTools[0].handler(args, ctx);
    expect(reads).toBe(2);
    expect(written).toEqual([["b.mov"]]);
  });

  it("reads back only the files it imported, not the whole bin, so a big bin cannot hide one or be capped", () => {
    const s = scene();
    const bin = s.project.addFolder("_Assets");
    const paths: string[] = [];
    for (let i = 0; i < 600; i++) {
      const p = `C:/proj/_assets/f${i}.mov`;
      paths.push(p);
      const src = new Src();
      src.file = { fsName: p };
      const f = new Footage(`f${i}.mov`, 10, 10, src);
      f.project = s.project;
      f.parentFolder = bin;
      s.project.all.push(f);
    }
    const whole = s.A.assetBinContents({ bin: "_Assets" });
    expect(whole.items).toHaveLength(500);
    expect(whole.truncated).toBe(true);
    const only = s.A.assetBinContents({ bin: "_Assets", only_paths: [paths[3], paths[590].toUpperCase().replace(/\//g, "\\")] });
    expect(only.items.map((i: any) => i.name)).toEqual(["f3.mov", "f590.mov"]);
    expect(only.truncated).toBe(false);
  });

  it("rules with subfolder_glob are refused together with paths, and an empty result still has a summary", async () => {
    expect(AeImportAssetsSchema.safeParse({ paths: ["C:/a/b.mov"], rules: [{ match: { subfolder_glob: "x*" }, interpret: { loop: 2 } }], expect: { project_path: "<unsaved>" } }).success).toBe(false);
    expect(AeImportAssetsSchema.safeParse({ rules: [{ match: { subfolder_glob: "x*" }, interpret: { loop: 2 } }], expect: { project_path: "<unsaved>" } }).success).toBe(true);
    const root = tempDir("chroma-summary-");
    touch(path.join(root, "_assets", "a.mov"));
    const project = path.join(root, "Show.aep");
    const { ctx } = fakeBridge({ footagePaths: () => ({ project_path: project, paths: [] }) }, project);
    const dry: any = await assetsTools[0].handler(AeImportAssetsSchema.parse({ dry_run: true, expect: { project_path: project } }), ctx);
    expect(dry.summary).toMatchObject({ imported: 0, failed: 0 });
    const none: any = await assetsTools[0].handler(AeImportAssetsSchema.parse({ expect: { project_path: project } }), ctx);
    expect(none.summary).toBeDefined();
    expect(none.imported).toEqual([]);
  });
});

describe("many-item interpretation: what the receipt and no_op say", () => {
  const items = (ids: number[], extra: object) => ids.map((id) => ({ item_id: id, ...extra }));
  const make = (n = 1) => {
    const s = scene();
    const list = Array.from({ length: n }, (_, i) => addFootage(s.project, `clip${i}.mov`));
    return { ...s, list };
  };

  it("plan_only plans and writes nothing: no undo group, no source write, the plan lists what would change", () => {
    const { A, undo, list } = make(2);
    const r = A.interpretBatch({ items: items(list.map((l) => l.id), { loop: 3 }), plan_only: true, expect: GUARD });
    expect(r.no_op).toBe(true);
    expect(r.changed_items.map((c: any) => c.changed)).toEqual([["loop"], ["loop"]]);
    expect(undo.begun).toBe(0);
    expect(list.every((l) => (l.mainSource as Src).writes.length === 0 && (l.mainSource as Src).loop === 1)).toBe(true);
  });

  it("every call the tool sends with mutates:false leaves the footage as it was; the one with mutates:true writes", async () => {
    const s = make(3);
    const { ctx } = hostBridge(s.A);
    const writes = () => s.list.reduce((n, l) => n + (l.mainSource as Src).writes.length, 0);
    const seen: Array<{ fn: string; mutates: boolean | undefined; wrote: number }> = [];
    const orig = ctx.bridge.callHost.bind(ctx.bridge);
    (ctx.bridge as any).callHost = async (fn: string, args: any, opts: any) => {
      const before = writes();
      const res = await orig(fn, args, opts);
      seen.push({ fn, mutates: opts?.mutates, wrote: writes() - before });
      return res;
    };
    const args = AeSetFootageInterpretationSchema.parse({ item_ids: s.list.map((l) => l.id), conform_frame_rate: 24, expect: GUARD });
    const out: any = await setTool.handler(args, ctx);
    expect(out.applied).toBe(true);
    expect(seen).toEqual([{ fn: "interpretBatch", mutates: false, wrote: 0 }]);
    expect(writes()).toBe(3);
  });

  it("when every write fails and is put back, nothing was written: no_op, restored rows, and the receipt still lists the failures", async () => {
    const s = make(2);
    for (const l of s.list) (l.mainSource as Src).failOn = "conformFrameRate";
    const r = s.A.interpretBatch({ items: items(s.list.map((l) => l.id), { conform_frame_rate: 24 }), strict: false, expect: GUARD });
    expect(r.changed_items).toEqual([]);
    expect(r.failed.map((f: any) => f.restored)).toEqual([true, true]);
    expect(r.no_op).toBe(true);
    const s2 = make(2);
    for (const l of s2.list) (l.mainSource as Src).failOn = "conformFrameRate";
    const { ctx } = hostBridge(s2.A);
    const out: any = await setTool.handler(AeSetFootageInterpretationSchema.parse({ item_ids: s2.list.map((l) => l.id), conform_frame_rate: 24, strict: false, expect: GUARD }), ctx);
    expect(out.summary).toMatchObject({ changed: 0, failed: 2 });
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches.map((m: any) => m.path)).toEqual(s2.list.map((l) => `items[${l.id}]`));
    expect(out.receipt.mismatches[0].actual).toBe("failed and put back");
  });

  it("when a failed write could not be put back, the batch is NOT a no_op and the row says so", async () => {
    const s = make(1);
    const src = s.list[0].mainSource as Src;
    src.failOn = "conformFrameRate";
    src.blockAfter = "fieldSeparationType";
    const r = s.A.interpretBatch({ items: items([s.list[0].id], { field_separation: "upper_field_first", conform_frame_rate: 24 }), strict: false, expect: GUARD });
    expect(r.failed[0].restored).toBe(false);
    expect(r.failed[0].message).toMatch(/could NOT be fully put back/);
    expect(r.no_op).toBe(false);
    const s2 = make(1);
    const src2 = s2.list[0].mainSource as Src;
    src2.failOn = "conformFrameRate";
    src2.blockAfter = "fieldSeparationType";
    const { ctx } = hostBridge(s2.A);
    const out: any = await setTool.handler(AeSetFootageInterpretationSchema.parse({ item_ids: [s2.list[0].id], field_separation: "upper_field_first", conform_frame_rate: 24, strict: false, expect: GUARD }), ctx);
    expect(out.no_op).toBe(false);
    expect(out.receipt.matches).toBe(false);
    expect(out.receipt.mismatches[0].actual).toBe("failed and NOT fully put back");
  });

  it("checks items that were already as asked too: one that changed behind the call's back is a mismatch", async () => {
    const s = make(2);
    (s.list[0].mainSource as Src).loop = 3;
    const { ctx } = hostBridge(s.A);
    // The second item changes between the host's write and the read-back.
    const origRead = s.A.interpretRead;
    let reads = 0;
    s.A.interpretRead = (a: any) => {
      if (++reads === 2) (s.list[0].mainSource as Src).loop = 7;
      return origRead(a);
    };
    const out: any = await setTool.handler(AeSetFootageInterpretationSchema.parse({ item_ids: s.list.map((l) => l.id), loop: 3, expect: GUARD }), ctx);
    expect(out.summary).toMatchObject({ changed: 1, no_change: 1 });
    expect(out.receipt.mismatches.map((m: any) => m.path)).toContain(`items[${s.list[0].id}].loop`);
  });

  it("keeps the receipt of a 200-item batch small: compact reads, and above 20 items only the items with a mismatch", async () => {
    const s = make(200);
    // One item whose loop write does not stick.
    const stuck = s.list[150].mainSource as Src;
    Object.defineProperty(stuck, "loop", { get: () => 1, set: () => {} });
    const { ctx, calls } = hostBridge(s.A);
    const out: any = await setTool.handler(AeSetFootageInterpretationSchema.parse({ item_ids: s.list.map((l) => l.id), loop: 2, expect: GUARD }), ctx);
    const reads = calls.filter((c) => c.fn === "interpretRead");
    expect(reads).toHaveLength(2);
    expect(reads.every((c) => c.args.compact === true)).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(45_000);
    expect(out.receipt.before).toMatchObject({ items_read: 200, trimmed: true });
    expect(out.receipt.after.items.map((i: any) => i.id)).toEqual([s.list[150].id]);
    expect(out.receipt.mismatches[0].path).toBe(`items[${s.list[150].id}].loop`);
    expect(out.summary).toMatchObject({ requested: 200, changed: 200 });
    // A compact read leaves out what the check never uses.
    const compact = s.A.interpretRead({ item_ids: [s.list[0].id], include_render_queue: false, compact: true }).items[0];
    expect(compact.file).toBeUndefined();
    expect(compact.proxy).toBeUndefined();
    expect(compact.loop).toBe(2);
  });
});
