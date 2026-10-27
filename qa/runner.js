// qa/runner.js — AE QA scenario runner with project isolation, raw global JSX loading,
// separate read-back assertions, and JUnit XML + Markdown report generation.
// Plain Node 20 ESM, zero external dependencies.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient, toExtendScriptPath } from "./client.js";
import { createAssertContext } from "./assert.js";
import { writeReports } from "./report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class IsolationError extends Error {
  constructor(message, projectState) {
    super(message);
    this.name = "IsolationError";
    this.projectState = projectState;
  }
}

/**
 * Returns true ONLY if the open project is:
 *  - unsaved (`!projectPath` or `"<unsaved>"`) AND empty (`numItems === 0`), OR
 *  - saved under a path containing `/_work/qa`.
 */
export function isSafeProjectState(state) {
  if (!state || typeof state !== "object") return false;
  const rawPath = String(state.projectPath || "").trim();
  const isUnsaved = !rawPath || rawPath === "<unsaved>";
  if (isUnsaved) {
    // Empty, or a project this runner made (marked in the project itself, not in
    // $.global, which would survive into the next project Jay opens).
    return Number(state.numItems) === 0 || state.qaOwned === true;
  }
  const normalized = rawPath.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/_work/qa");
}

/**
 * Queries After Effects for the currently open project's path, item count, and QA ownership tag.
 */
export async function readProjectIsolationState(client) {
  return client.eval(
    `(function(){
      var f = (app.project && app.project.file) ? String(app.project.file.fsName) : "";
      var n = app.project ? Number(app.project.numItems) : 0;
      var qaOwned = false;
      if (!f) {
        for (var i = 1; i <= n; i++) {
          var it = app.project.item(i);
          if (it instanceof FolderItem && it.name === "__chroma_qa__" && it.parentFolder === app.project.rootFolder) { qaOwned = true; break; }
        }
      }
      return { projectPath: f, numItems: n, qaOwned: qaOwned };
    })()`,
    { label: "qa:checkProjectState" }
  );
}

/**
 * Refuses to run unless the open project is unsaved and empty, or sits under `/_work/qa`.
 */
export async function assertSafeInitialProject(client) {
  const state = await readProjectIsolationState(client);
  if (!isSafeProjectState(state)) {
    throw new IsolationError(
      `Refusing to run QA harness: open project "${
        state?.projectPath || "<unsaved>"
      }" (numItems=${state?.numItems}) is neither unsaved-and-empty nor under "/_work/qa".`,
      state
    );
  }
  return state;
}

/**
 * Closes the current QA project with CloseOptions.DO_NOT_SAVE_CHANGES and creates
 * a fresh project with app.newProject(). Never closes a non-QA project.
 */
export async function resetQaProject(client) {
  const state = await readProjectIsolationState(client);
  const isQaSavedPath =
    Boolean(state?.projectPath) && isSafeProjectState(state);
  const isUnsavedEmpty =
    !state?.projectPath && Number(state?.numItems) === 0;
  const isUnsavedQaOwned =
    !state?.projectPath && state?.qaOwned === true;

  if (!isQaSavedPath && !isUnsavedEmpty && !isUnsavedQaOwned) {
    throw new IsolationError(
      `Refusing to close non-QA project "${
        state?.projectPath || "<unsaved>"
      }" (numItems=${state?.numItems}).`,
      state
    );
  }

  return client.eval(
    `(function(){
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
      app.newProject();
      // Ownership marker, checked by readProjectIsolationState.
      app.project.items.addFolder("__chroma_qa__");
      return {
        projectPath: app.project.file ? String(app.project.file.fsName) : "",
        numItems: Number(app.project.numItems)
      };
    })()`,
    { label: "qa:resetProject" }
  );
}

/**
 * Resolves a JSX path from a scenario's `load` list to an absolute path.
 */
export function resolveLoadPath(loadEntry, scenarioFile) {
  if (path.isAbsolute(loadEntry) && fs.existsSync(loadEntry)) {
    return toExtendScriptPath(loadEntry);
  }
  const candidates = [];
  if (scenarioFile) {
    candidates.push(path.resolve(path.dirname(scenarioFile), loadEntry));
  }
  candidates.push(path.resolve(process.cwd(), loadEntry));
  if (process.env.VOXMARK_ROOT) {
    candidates.push(path.resolve(process.env.VOXMARK_ROOT, loadEntry));
  }
  candidates.push(path.resolve("H:/Github_repos/AFX-VoxMark", loadEntry));

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return toExtendScriptPath(c);
    }
  }
  return toExtendScriptPath(loadEntry);
}

/**
 * Builds the `ae` helper object passed to `scenario.run(ae)` and `scenario.assert(ae, t)`.
 * All `ae.read.*` methods execute in separate `evalScript` calls so AE 26 never returns stale state.
 */
export function createScenarioAeContext(client) {
  const read = {
    async markers() {
      return client.eval(
        `(function(){
          var comp = app.project.activeItem;
          if (!comp || !(comp instanceof CompItem)) {
            throw new Error("No active composition when reading markers.");
          }
          var mp = comp.markerProperty;
          var out = [];
          for (var i = 1; i <= mp.numKeys; i++) {
            var val = mp.keyValue(i);
            var label = 0;
            try { label = val.label || 0; } catch (e1) {}
            var prm = {};
            try { prm = val.getParameters() || {}; } catch (e2) { prm = {}; }
            var voice = prm.voxmarkVoice ? String(prm.voxmarkVoice) : "";
            var fullText = prm.voxmarkText ? String(prm.voxmarkText) : "";
            out.push({
              index: i,
              time: mp.keyTime(i),
              duration: val.duration,
              comment: String(val.comment || ""),
              label: label,
              params: prm,
              voxmarkVoice: voice,
              voxmarkText: fullText,
              voice: voice,
              fullText: fullText
            });
          }
          return out;
        })()`,
        { label: "qa:read.markers" }
      );
    },

    async comp() {
      return client.eval(
        `(function(){
          var comp = app.project.activeItem;
          if (!comp || !(comp instanceof CompItem)) return null;
          return {
            id: comp.id,
            name: comp.name,
            width: comp.width,
            height: comp.height,
            fps: comp.frameRate,
            duration: comp.duration,
            time: comp.time,
            workAreaStart: comp.workAreaStart,
            workAreaDuration: comp.workAreaDuration,
            numLayers: comp.numLayers
          };
        })()`,
        { label: "qa:read.comp" }
      );
    },

    async layers() {
      return client.eval(
        `(function(){
          var comp = app.project.activeItem;
          if (!comp || !(comp instanceof CompItem)) return [];
          var out = [];
          for (var i = 1; i <= comp.numLayers; i++) {
            var l = comp.layer(i);
            out.push({
              index: l.index,
              name: l.name,
              inPoint: l.inPoint,
              outPoint: l.outPoint,
              startTime: l.startTime,
              enabled: l.enabled,
              solo: Boolean(l.solo)
            });
          }
          return out;
        })()`,
        { label: "qa:read.layers" }
      );
    },

    async items() {
      return client.eval(
        `(function(){
          var out = [];
          for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            out.push({
              id: it.id,
              name: it.name,
              typeName: it.typeName
            });
          }
          return out;
        })()`,
        { label: "qa:read.items" }
      );
    },

    async renderQueue() {
      return client.eval(
        `(function(){
          var rq = app.project.renderQueue;
          var items = [];
          for (var i = 1; i <= rq.numItems; i++) {
            var it = rq.item(i);
            items.push({
              index: i,
              compName: it.comp ? it.comp.name : "",
              status: String(it.status)
            });
          }
          return { numItems: rq.numItems, items: items };
        })()`,
        { label: "qa:read.renderQueue" }
      );
    },
  };

  /**
   * Helper to place a non-VoxMark user marker directly on the active comp.
   */
  async function addCompMarker({
    time,
    comment,
    duration = 0,
    label = 0,
  }) {
    return client.eval(
      `(function(){
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
          throw new Error("No active composition.");
        }
        var mv = new MarkerValue(${JSON.stringify(String(comment ?? ""))});
        if (${Number(duration) || 0} > 0) {
          mv.duration = ${Number(duration) || 0};
        }
        if (${Number(label) || 0} > 0) {
          try { mv.label = ${Number(label) || 0}; } catch (e) {}
        }
        comp.markerProperty.setValueAtTime(${Number(time)}, mv);
        return { ok: true, numKeys: comp.markerProperty.numKeys };
      })()`,
      { label: "qa:addCompMarker" }
    );
  }

  return {
    client,
    eval: (script, opts) => client.eval(script, opts),
    evalRaw: (script, opts) => client.evalRaw(script, opts),
    evalFile: (filePath, opts) => client.evalFile(filePath, opts),
    call: (fnName, args, opts) => client.call(fnName, args, opts),
    addCompMarker,
    read,
  };
}

/**
 * Runs a single scenario following the 5-step isolation & execution lifecycle:
 *  1. Close QA project with CloseOptions.DO_NOT_SAVE_CHANGES, then app.newProject().
 *  2. Never suppress dialogs (Jay's rule): a blocking popup is read with ae_dialogs and reported.
 *  3. Create the scenario's comp and open it in the viewer.
 *  4. Load product JSX via raw $.evalFile(<absolute path>).
 *  5. Run scenario.run(ae), then scenario.assert(ae, t) via separate reads.
 */
export async function runScenario(scenario, client, options = {}) {
  const startedAt = Date.now();
  const compCfg = {
    name: scenario.fixtures?.comp?.name || "QA Test Comp",
    w: Number(scenario.fixtures?.comp?.w) || 1920,
    h: Number(scenario.fixtures?.comp?.h) || 1080,
    pixelAspect: Number(scenario.fixtures?.comp?.pixelAspect) || 1,
    seconds: Number(scenario.fixtures?.comp?.seconds) || 10,
    fps: Number(scenario.fixtures?.comp?.fps) || 25,
  };
  const t = createAssertContext({ fps: compCfg.fps });
  const ae = createScenarioAeContext(client);

  try {
    // 1. Close previous QA project without saving and create a fresh project.
    await resetQaProject(client);

    // 2. Dialogs are never suppressed (Jay's rule). A popup that blocks the
    //    scenario surfaces as a timeout and is read with ae_dialogs.

    // 3. Create the scenario's comp and open it in the viewer so it becomes app.project.activeItem.
    await client.eval(
      `(function(){
        var comp = app.project.items.addComp(
          ${JSON.stringify(compCfg.name)},
          ${compCfg.w},
          ${compCfg.h},
          ${compCfg.pixelAspect},
          ${compCfg.seconds},
          ${compCfg.fps}
        );
        comp.openInViewer();
        return { id: comp.id, name: comp.name };
      })()`,
      { label: "qa:createComp" }
    );

    // 4. Load product JSX into global scope using raw $.evalFile(<absPath>).
    const loadList = Array.isArray(scenario.load) ? scenario.load : [];
    for (const entry of loadList) {
      const absJsx = resolveLoadPath(entry, options.scenarioFile);
      await client.evalFile(absJsx, {
        skipExistsCheck: options.skipExistsCheck === true,
      });
    }

    // 5a. Run the action.
    if (typeof scenario.run === "function") {
      await scenario.run(ae);
    }

    // 5b. Run assertions in separate read evalScripts.
    if (typeof scenario.assert === "function") {
      await scenario.assert(ae, t);
    }

    return {
      name: scenario.name || options.scenarioFile || "Unnamed scenario",
      file: options.scenarioFile || null,
      status: "passed",
      durationMs: Date.now() - startedAt,
      assertions: t.checks.length,
      snapshots: [],
    };
  } catch (err) {
    return {
      name: scenario.name || options.scenarioFile || "Unnamed scenario",
      file: options.scenarioFile || null,
      status: "failed",
      durationMs: Date.now() - startedAt,
      assertions: t.checks.length,
      error: err,
      snapshots: [],
    };
  }
}

/**
 * Discovers `.mjs` scenario files from a directory or file list.
 */
export function discoverScenarioFiles(targets) {
  const inputs =
    Array.isArray(targets) && targets.length > 0
      ? targets
      : [path.join(__dirname, "scenarios", "voxmark")];
  const files = [];

  function walk(targetPath) {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Scenario path does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved).sort();
      for (const entry of entries) {
        const full = path.join(resolved, entry);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.mjs$/i.test(entry)) {
          files.push(full);
        }
      }
    } else if (/\.mjs$/i.test(resolved)) {
      files.push(resolved);
    }
  }

  for (const t of inputs) {
    walk(t);
  }
  return files;
}

/**
 * Runs a suite of scenarios (either loaded objects or file paths), writes reports to `qa/out/`,
 * and returns the suite summary + report paths.
 */
export async function runSuite(options = {}) {
  const client = options.client || createClient(options.clientOptions);
  const outDir = options.outDir || path.join(__dirname, "out");
  const suiteName = options.suiteName || "chroma-ae-qa";
  const suiteStarted = Date.now();

  // Guard: refuse to start unless open project is unsaved+empty or under /_work/qa.
  await assertSafeInitialProject(client);

  let scenarioEntries = [];
  if (Array.isArray(options.scenarios)) {
    scenarioEntries = options.scenarios.map((s) =>
      s.scenario ? s : { scenario: s, file: s.file || null }
    );
  } else {
    const files = discoverScenarioFiles(options.targets);
    for (const file of files) {
      const mod = await import(pathToFileURL(file).href);
      const scenario = mod.default || mod;
      scenarioEntries.push({ scenario, file });
    }
  }

  const results = [];
  for (const entry of scenarioEntries) {
    if (entry.error instanceof IsolationError) {
      throw entry.error;
    }
    const res = await runScenario(entry.scenario, client, {
      scenarioFile: entry.file,
      skipExistsCheck: options.skipExistsCheck,
    });
    results.push(res);
    if (res.error instanceof IsolationError) {
      throw res.error;
    }
  }

  const suiteResult = {
    suiteName,
    startedAt: new Date(suiteStarted).toISOString(),
    durationMs: Date.now() - suiteStarted,
    scenarios: results,
  };

  // 6. Write JUnit XML plus Markdown report to qa/out/.
  const reports = writeReports(suiteResult, outDir);

  return {
    ...suiteResult,
    ...reports,
    passed: results.every((r) => r.status === "passed"),
  };
}

// CLI entry point
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const args = process.argv.slice(2);
  runSuite({ targets: args })
    .then((summary) => {
      for (const s of summary.scenarios) {
        const tag = s.status === "passed" ? "PASS" : "FAIL";
        console.log(`[${tag}] ${s.name} (${s.durationMs}ms, ${s.assertions} assertions)`);
        if (s.error) {
          console.error(`       ${s.error.message}`);
        }
      }
      console.log(`\nReports written to:\n  - ${summary.junitPath}\n  - ${summary.markdownPath}`);
      process.exit(summary.passed ? 0 : 1);
    })
    .catch((err) => {
      console.error(`QA Runner aborted: ${err.message}`);
      process.exit(2);
    });
}
