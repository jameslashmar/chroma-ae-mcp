import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_GPU_WARN_MB,
  classifyResources,
  defaultRun,
  execText,
  locateProbe,
  parsePsOutput,
  GPU_HIGH_FRACTION,
  GPU_WARN_FRACTION,
  parseProbeOutput,
  readResources,
  resetResourceCache,
  resourceDeps,
  resourceWarnings,
  resourceWarningsForRender,
  resourcesForStatus,
  type RawProbe,
} from "../src/system-resources.js";

const GB = 1024;
const raw = (usedGb: number, totalGb: number | null, processes: RawProbe["processes"] = []): RawProbe => ({
  ok: true,
  adapters: [
    { luid: "a", used_mb: usedGb * GB },
    { luid: "igpu", used_mb: 0 },
  ],
  totals: totalGb === null ? [] : [{ name: "RTX 4090", total_mb: totalGb * GB }],
  processes,
});

const original = { ...resourceDeps };
beforeEach(() => resetResourceCache());
afterEach(() => {
  Object.assign(resourceDeps, original);
  resetResourceCache();
});

describe("classifyResources", () => {
  it("names the thresholds as constants", () => {
    expect(GPU_WARN_FRACTION).toBe(0.85);
    expect(GPU_HIGH_FRACTION).toBe(0.93);
    expect(APP_GPU_WARN_MB).toBe(1024);
  });

  it("22.5 of 24 GB is high, with the percentage and GB in the warning", () => {
    const r = classifyResources(raw(22.5, 24));
    expect(r.level).toBe("high");
    expect(r.gpu).toMatchObject({ used_mb: 23040, total_mb: 24576, used_pct: 93.8, level: "high" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/94 % full \(22\.5 of 24\.0 GB\)/);
  });

  it("20.4 of 24 GB (85 %) warns, 10 of 24 is ok and quiet", () => {
    expect(classifyResources(raw(20.4, 24)).level).toBe("warn");
    const ok = classifyResources(raw(10, 24));
    expect(ok.level).toBe("ok");
    expect(ok.warnings).toEqual([]);
  });

  it("under 1.5 GB free is high even below 93 %", () => {
    expect(classifyResources(raw(7, 8)).level).toBe("high");
  });

  it("names Cinema 4D and its pid when the card is nearly full", () => {
    const r = classifyResources(raw(22.5, 24, [{ pid: 41264, name: "Cinema 4D", gpu_mb: 9000 }, { pid: 5, name: "AfterFX", gpu_mb: 2000 }]));
    expect(r.warnings[0]).toMatch(/Cinema 4D \(pid 41264\) is running and holds the largest share/);
    expect(r.warnings[0]).toMatch(/Close or pause the other app, or tell me to go on/);
    expect(r.heavy_apps.find((a) => a.name === "AfterFX")).toMatchObject({ ae: true });
  });

  it("does not nag about an idle Cinema 4D on a card with room", () => {
    const quiet = classifyResources(raw(9.6, 24, [{ pid: 7, name: "Cinema 4D", gpu_mb: 300 }]));
    expect(quiet.warnings).toEqual([]);
    const heavy = classifyResources(raw(9.6, 24, [{ pid: 7, name: "Cinema 4D", gpu_mb: 2 * GB }]));
    expect(heavy.warnings).toHaveLength(1);
    expect(heavy.warnings[0]).toMatch(/Cinema 4D is running \(pid 7\) and uses about 2\.0 GB of GPU memory/);
    const busy = classifyResources(raw(20.5, 24, [{ pid: 9, name: "blender", gpu_mb: 300 }]));
    expect(busy.warnings.join(" ")).toMatch(/Blender is running \(pid 9\)/);
  });

  it("never prints a per-process number above what the adapter uses, and does not nag on it", () => {
    // 14.6 GB for a process on a card whose adapter reads 7.8 GB, and 54 GB on a 24 GB card (both measured on the counter).
    const r = classifyResources(raw(7.8, 24, [{ pid: 3, name: "blender", gpu_mb: 14_921 }, { pid: 4, name: "Cinema 4D", gpu_mb: 55_652 }]));
    expect(r.warnings).toEqual([]);
    expect(r.heavy_apps.map((a) => a.gpu_mb)).toEqual([undefined, undefined]);
    expect(r.heavy_apps.every((a) => a.gpu_figure_unreliable === true)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/14921|55652/);
    // under pressure the app is named, still without the figure
    const busy = classifyResources(raw(22.5, 24, [{ pid: 3, name: "blender", gpu_mb: 55_652 }]));
    expect(busy.warnings.join(" ")).toMatch(/Blender is running \(pid 3\)\./);
    expect(busy.warnings.join(" ")).not.toMatch(/55|54\.\d GB|holds the largest share/);
  });

  it("prints no per-process figure at all without a GPU reading", () => {
    const r = classifyResources({ ok: true, counters: false, adapters: [], totals: [], processes: [{ pid: 3, name: "blender", gpu_mb: 54_000 }] });
    expect(r.gpu).toBeNull();
    expect(r.heavy_apps[0].gpu_mb).toBeUndefined();
    // The app is named, but no figure is printed anywhere in the text.
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).not.toMatch(/GB|54/);
  });

  it("a small card is not high just because little is free (1 GB card, 100 MB used)", () => {
    const small: RawProbe = { ok: true, adapters: [{ luid: "a", used_mb: 100 }], totals: [{ name: "tiny", total_mb: 1024 }], processes: [] };
    const r = classifyResources(small);
    expect(r.level).toBe("ok");
    expect(r.warnings).toEqual([]);
    // the free-memory rule still applies once the warn fraction is reached: 8 GB card, 7 GB used
    expect(classifyResources(raw(7, 8)).level).toBe("high");
    expect(classifyResources({ ...small, adapters: [{ luid: "a", used_mb: 900 }] }).level).toBe("high");
  });

  it("gives a percentage only for exactly one total and a figure at or below it", () => {
    const two: RawProbe = { ok: true, adapters: [{ luid: "a", used_mb: 11.8 * GB }], totals: [{ name: "RTX 4090", total_mb: 24 * GB }, { name: "RTX 3060", total_mb: 12 * GB }], processes: [] };
    const a = classifyResources(two);
    expect(a.gpu).toMatchObject({ total_mb: null, used_pct: null, level: "ok" });
    expect(a.warnings).toEqual([]);
    // a figure above the only total: no 800 % full
    const over: RawProbe = { ok: true, adapters: [{ luid: "a", used_mb: 8 * GB }], totals: [{ name: "1 GB card", total_mb: 1 * GB }], processes: [] };
    const b = classifyResources(over);
    expect(b.gpu).toMatchObject({ used_pct: null, total_mb: null, level: "ok" });
    expect(JSON.stringify(b.warnings)).not.toMatch(/%/);
  });

  it("keeps the apps when the counters cannot be read (another language, an old Windows)", () => {
    const r = classifyResources({ ok: true, counters: false, error: "no such counter", adapters: [], totals: [{ name: "x", total_mb: 24 * GB }], processes: [{ pid: 9, name: "blender", gpu_mb: null }] });
    expect(r.supported).toBe(false);
    expect(r.heavy_apps).toHaveLength(1);
    expect(r.probe_error).toBe("no such counter");
    // even when the probe says ok:false, the process list it did read is used
    const bad = classifyResources({ ok: false, error: "boom", adapters: [], totals: [], processes: [{ pid: 9, name: "blender", gpu_mb: null }] });
    expect(bad.heavy_apps).toHaveLength(1);
    expect(bad.gpu).toBeNull();
  });

  it("says After Effects holds the memory when it does, and not Cinema 4D", () => {
    const r = classifyResources(raw(22.5, 24, [{ pid: 5, name: "AfterFX", gpu_mb: 20 * GB }]));
    expect(r.ae_holds_most).toBe(true);
    expect(r.warnings[0]).toMatch(/After Effects itself holds most of it/);
    expect(r.warnings[0]).not.toMatch(/Close or pause the other app/);
    const other = classifyResources(raw(22.5, 24, [{ pid: 5, name: "AfterFX", gpu_mb: 3 * GB }, { pid: 6, name: "Cinema 4D", gpu_mb: 15 * GB }]));
    expect(other.ae_holds_most).toBe(false);
  });

  it("says possibly for the generic Commandline name", () => {
    const r = classifyResources(raw(22, 24, [{ pid: 12, name: "Commandline", gpu_mb: 4 * GB }]));
    expect(r.warnings.join(" ")).toMatch(/possibly/);
  });

  it("gives no percentage warning, and no throw, when no total is found", () => {
    const r = classifyResources(raw(22, null));
    expect(r.gpu).toMatchObject({ total_mb: null, used_pct: null, level: "ok" });
    expect(r.warnings).toEqual([]);
  });

  it("is quiet and unsupported when the counters are missing", () => {
    expect(classifyResources({ ok: false, error: "no counters", adapters: [], totals: [], processes: [] })).toMatchObject({ supported: false, gpu: null, warnings: [], probe_error: "no counters" });
    expect(classifyResources(null)).toMatchObject({ supported: false, warnings: [] });
    expect(classifyResources(undefined)).toMatchObject({ supported: false });
    // counters fine, no adapters: apps may still be listed, no GPU line
    const apps = classifyResources({ ok: true, adapters: [], totals: [], processes: [{ pid: 1, name: "blender", gpu_mb: null }] });
    expect(apps).toMatchObject({ supported: false, gpu: null });
    expect(apps.heavy_apps).toHaveLength(1);
    // ... but a render still hears that another heavy renderer runs (the process list works without counters); the status wording stays quiet
    expect(apps.warnings).toHaveLength(1);
    expect(apps.warnings[0]).toMatch(/is running \(pid 1\)\..*GPU use could not be read/);
    expect(resourceWarnings(apps, "status")).toEqual([]);
  });

  it("survives junk in the probe output", () => {
    const junk = { ok: true, adapters: [{ luid: "x", used_mb: "many" }, null], totals: "none", processes: [{ pid: "1" }, null, { pid: 2, name: 7 }] } as unknown as RawProbe;
    expect(() => classifyResources(junk)).not.toThrow();
  });

  it("status warnings leave out the render advice; 'close the other app' only when there is another app", () => {
    const r = classifyResources(raw(22.5, 24, [{ pid: 6, name: "Cinema 4D", gpu_mb: 15 * GB }]));
    expect(resourceWarnings(r, "status")[0]).not.toMatch(/Close or pause/);
    expect(resourceWarnings(r, "render")[0]).toMatch(/Close or pause the other app/);
    const alone = classifyResources(raw(22.5, 24));
    expect(alone.warnings[0]).toMatch(/A render now may be slow or fail/);
    expect(alone.warnings[0]).not.toMatch(/other app/);
  });
});

describe("parseProbeOutput", () => {
  it("takes the last JSON line and turns a single object into a list", () => {
    const text = 'banner\n{"ok":true,"adapters":{"luid":"a","used_mb":5},"totals":[],"processes":[]}\n';
    expect(parseProbeOutput(text)).toMatchObject({ ok: true, adapters: [{ luid: "a", used_mb: 5 }] });
    expect(parseProbeOutput("nothing here")).toBeNull();
  });
});

describe("readResources", () => {
  it("runs one probe for two calls within 10 s", async () => {
    let runs = 0;
    let t = 1_000;
    Object.assign(resourceDeps, { platform: () => "win32" as const, now: () => t, run: async () => (runs++, raw(10, 24)) });
    await readResources();
    t += 5_000;
    await readResources();
    expect(runs).toBe(1);
    t += 6_000;
    await readResources();
    expect(runs).toBe(2);
  });

  it("shares one probe between calls that overlap", async () => {
    let runs = 0;
    Object.assign(resourceDeps, { platform: () => "win32" as const, run: async () => (runs++, await new Promise((r) => setTimeout(r, 20)), raw(10, 24)) });
    await Promise.all([readResources(), readResources(), readResources()]);
    expect(runs).toBe(1);
  });

  it("gives an empty report when the runner throws or returns nothing", async () => {
    Object.assign(resourceDeps, { platform: () => "win32" as const, run: async () => { throw new Error("boom"); } });
    expect(await readResources()).toMatchObject({ supported: false, warnings: [] });
    resetResourceCache();
    Object.assign(resourceDeps, { run: async () => null });
    expect(await readResources()).toMatchObject({ supported: false, warnings: [] });
  });

  it("runs no probe on Linux, and on macOS gives apps only and no GPU figure", async () => {
    let runs = 0;
    Object.assign(resourceDeps, { platform: () => "linux" as const, run: async () => (runs++, raw(1, 2)) });
    expect(await readResources()).toMatchObject({ supported: false, gpu: null, warnings: [] });
    expect(runs).toBe(0);
    resetResourceCache();
    Object.assign(resourceDeps, { platform: () => "darwin" as const, run: async () => ({ ok: true, adapters: [], totals: [], processes: [{ pid: 4, name: "blender", gpu_mb: null }] }) });
    const mac = await readResources();
    expect(mac).toMatchObject({ supported: false, gpu: null });
    expect(mac.warnings).toHaveLength(1); // the running app is named, without a figure
    expect(mac.heavy_apps[0]).toMatchObject({ pid: 4 });
    expect(mac.probe_error).toBeUndefined();
  });

  it("never touches the eval queue: it takes no context at all", async () => {
    // The module has no import of the queue or the bridge, and the function has no parameter to pass one.
    expect(readResources.length).toBe(0);
    Object.assign(resourceDeps, { platform: () => "win32" as const, run: async () => raw(22.5, 24) });
    expect((await resourceWarningsForRender())[0]).toMatch(/GPU memory is 94 % full/);
  });

  it("resourcesForStatus is the report with the plain status wording", async () => {
    Object.assign(resourceDeps, { platform: () => "win32" as const, run: async () => raw(22.5, 24, [{ pid: 41264, name: "Cinema 4D", gpu_mb: 9000 }]) });
    const r = await resourcesForStatus();
    expect(r).toMatchObject({ supported: true, level: "high", gpu: { used_pct: 93.8 } });
    expect(r.heavy_apps[0]).toMatchObject({ pid: 41264, label: "Cinema 4D" });
    expect(r.warnings[0]).toMatch(/Cinema 4D/);
    expect(r.warnings[0]).not.toMatch(/Close or pause/);
    Object.assign(resourceDeps, { run: async () => { throw new Error("x"); } });
    resetResourceCache();
    expect(await resourcesForStatus()).toMatchObject({ supported: false, warnings: [] });
  });

  it("starts no PowerShell under the test runner: the setup file replaced the runner", async () => {
    // test/setup-resources.ts runs before every test file and sets resourceDeps.run to a probe that finds nothing.
    expect(await original.run("win32")).toBeNull();
    Object.assign(resourceDeps, { platform: () => "win32" as const });
    expect(await readResources()).toMatchObject({ supported: false, warnings: [] });
  });
});

describe("the real probe pieces", () => {
  it("parsePsOutput keeps matching apps by their base name", () => {
    const text = "  101 /Applications/Blender.app/Contents/MacOS/Blender\n  202 /usr/bin/ssh\n 303 /Applications/Cinema 4D/Cinema 4D.app/Contents/MacOS/Cinema 4D\n";
    const found = parsePsOutput(text, new RegExp("^(Blender|Cinema 4D)$", "i"));
    expect(found).toEqual([{ pid: 101, name: "Blender", gpu_mb: null }, { pid: 303, name: "Cinema 4D", gpu_mb: null }]);
  });

  it("execText returns what a program prints, and nothing for one that fails", async () => {
    expect((await execText(process.execPath, ["-e", "process.stdout.write('hello')"])).trim()).toBe("hello");
    expect(await execText(process.execPath, ["-e", "process.exit(3)"])).toBe("");
    expect(await execText("chroma-no-such-program-xyz", [])).toBe("");
  });

  it("locateProbe finds resource-probe.ps1 from here", () => {
    const found = locateProbe();
    expect(found).not.toBeNull();
    expect(found!.endsWith("resource-probe.ps1")).toBe(true);
  });

  it("defaultRun gives null on Linux and the process list only on macOS", async () => {
    expect(await defaultRun("linux")).toBeNull();
    expect(await defaultRun("aix" as NodeJS.Platform)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("defaultRun on Windows runs the script and returns a reading (reads counters and the process list only)", async () => {
    const raw = await defaultRun("win32");
    expect(raw).not.toBeNull();
    expect(raw!.ok).toBe(true);
    expect(Array.isArray(raw!.adapters)).toBe(true);
    expect(Array.isArray(raw!.processes)).toBe(true);
    const r = classifyResources(raw);
    expect(typeof r.supported).toBe("boolean");
  }, 20_000);
});
