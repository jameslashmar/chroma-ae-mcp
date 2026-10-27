// qa/test/harness.test.mjs — Offline tests for client.js, assert.js, report.js,
// runner.js isolation guards, and VoxMark scenarios 1–3 against a simulated AE ExtendScript bridge.

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createClient, resolveTokenPath, readToken } from "../client.js";
import { createAssertContext, QaAssertionError } from "../assert.js";
import { buildJUnitXml, buildMarkdownReport, writeReports } from "../report.js";
import {
  isSafeProjectState,
  assertSafeInitialProject,
  resetQaProject,
  runSuite,
  IsolationError,
} from "../runner.js";

import scenario01, {
  TWO_SPEAKERS,
  VOXMARK_LABEL_CYCLE,
} from "../scenarios/voxmark/01-markers-speakers.mjs";
import scenario02, {
  INITIAL_MARKERS,
  EDITED_SECOND_TEXT,
} from "../scenarios/voxmark/02-edit-in-place.mjs";
import scenario03, {
  USER_MARKER,
  TRANSCRIPT_MARKERS,
} from "../scenarios/voxmark/03-selective-purge.mjs";

const TEST_TOKEN = "a".repeat(64);

/**
 * Simulated After Effects + VoxMark host environment backing a mock HTTP bridge server.
 * Records every request (including `raw` flag) and enforces separate-evalScript reads.
 */
function createMockAeBridge(initialState = {}) {
  const state = {
    projectPath: initialState.projectPath ?? "",
    numItems: initialState.numItems ?? 0,
    qaOwned: initialState.qaOwned ?? false,
    dialogsSuppressed: false,
    closeCalls: [],
    newProjectCalls: 0,
    loadedFiles: [],
    activeComp: null,
    markers: [],
    requests: [],
  };

  function handleScript(script, raw) {
    const s = String(script).trim();

    if (raw) {
      const m = /^\$\.evalFile\((.+)\);?$/.exec(s);
      if (m) {
        const filePath = JSON.parse(m[1]);
        state.loadedFiles.push(filePath);
        return "undefined";
      }
      return "raw_ok";
    }

    // 1. Isolation check
    if (s.includes("qaOwned: qaOwned")) {
      return {
        projectPath: state.projectPath,
        numItems: state.numItems,
        qaOwned: state.qaOwned,
      };
    }

    // 2. Project reset
    if (s.includes("app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)")) {
      state.closeCalls.push({
        projectPath: state.projectPath,
        numItems: state.numItems,
      });
      state.newProjectCalls += 1;
      state.projectPath = "";
      state.numItems = 0;
      state.qaOwned = true;
      state.activeComp = null;
      state.markers = [];
      return { projectPath: "", numItems: 0 };
    }

    // 3. Suppress dialogs
    if (s.includes("app.beginSuppressDialogs()")) {
      state.dialogsSuppressed = true;
      return true;
    }
    if (s.includes("app.endSuppressDialogs(false)")) {
      state.dialogsSuppressed = false;
      return true;
    }

    // 4. Create comp and open in viewer
    if (s.includes("app.project.items.addComp")) {
      const match =
        /addComp\(\s*("[^"]+")\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(
          s
        );
      const comp = {
        id: 1,
        name: match ? JSON.parse(match[1]) : "QA Test Comp",
        width: match ? Number(match[2]) : 1920,
        height: match ? Number(match[3]) : 1080,
        pixelAspect: match ? Number(match[4]) : 1,
        duration: match ? Number(match[5]) : 10,
        fps: match ? Number(match[6]) : 25,
      };
      state.activeComp = comp;
      state.numItems = 1;
      state.markers = [];
      return { id: comp.id, name: comp.name };
    }

    // 5. Add user comp marker
    if (s.includes("comp.markerProperty.setValueAtTime") && s.includes("new MarkerValue")) {
      const commentMatch = /new MarkerValue\((".*?")\)/.exec(s);
      const timeMatch = /setValueAtTime\(([\d.]+),\s*mv\)/.exec(s);
      const durMatch = /mv\.duration\s*=\s*([\d.]+)/.exec(s);
      const labelMatch = /mv\.label\s*=\s*(\d+)/.exec(s);
      const time = timeMatch ? Number(timeMatch[1]) : 0;
      const mv = {
        time,
        duration: durMatch ? Number(durMatch[1]) : 0,
        comment: commentMatch ? JSON.parse(commentMatch[1]) : "",
        label: labelMatch ? Number(labelMatch[1]) : 0,
        params: {},
      };
      const existingIdx = state.markers.findIndex(
        (k) => Math.abs(k.time - time) < 0.0005
      );
      if (existingIdx >= 0) state.markers[existingIdx] = mv;
      else state.markers.push(mv);
      state.markers.sort((a, b) => a.time - b.time);
      return { ok: true, numKeys: state.markers.length };
    }

    // 6. VoxMark host functions (require hostscript-aeft.jsx loaded + activeComp)
    if (s.startsWith("createCompMarkers(")) {
      if (!state.activeComp) {
        return JSON.stringify({ error: "No active composition." });
      }
      const argsJson = `[${s.slice("createCompMarkers(".length, -1)}]`;
      const [markersJson, layerStartTime, clearFirst] = JSON.parse(argsJson);
      const input = JSON.parse(markersJson);
      if (clearFirst) {
        state.markers = [];
      }
      let created = 0;
      let skipped = 0;
      let labelsApplied = 0;
      for (const m of input) {
        const text = String(m.text || "").trim();
        if (!text) {
          skipped++;
          continue;
        }
        const compTime = m.start + Number(layerStartTime || 0);
        const duration = m.end - m.start;
        if (compTime < 0 || compTime >= state.activeComp.duration) {
          skipped++;
          continue;
        }
        let label = 0;
        if (typeof m.speakerIndex === "number" && m.speakerIndex >= 0) {
          label =
            VOXMARK_LABEL_CYCLE[m.speakerIndex % VOXMARK_LABEL_CYCLE.length];
          labelsApplied++;
        }
        const params = { voxmarkText: text };
        if (m.speaker) params.voxmarkVoice = String(m.speaker);
        const mv = {
          time: compTime,
          duration:
            duration > 0.01
              ? Math.min(duration, state.activeComp.duration - compTime)
              : 0,
          comment: text,
          label,
          params,
        };
        const idx = state.markers.findIndex(
          (k) => Math.abs(k.time - compTime) < 0.0005
        );
        if (idx >= 0) state.markers[idx] = mv;
        else state.markers.push(mv);
        created++;
      }
      state.markers.sort((a, b) => a.time - b.time);
      return JSON.stringify({
        success: true,
        created,
        skipped,
        _diag: { labelSupported: true, labelsApplied },
      });
    }

    if (s.startsWith("updateMarkerTextAtTime(")) {
      if (!state.activeComp) {
        return JSON.stringify({ error: "No active composition." });
      }
      const argsJson = `[${s.slice("updateMarkerTextAtTime(".length, -1)}]`;
      const [payloadJson] = JSON.parse(argsJson);
      const payload = JSON.parse(payloadJson);
      let updated = 0;
      let hiddenSkipped = 0;
      let missed = 0;
      for (const edit of payload.edits || []) {
        const want = Number(edit.time);
        const newText = String(edit.text || "");
        const found = state.markers.findIndex(
          (k) => Math.abs(k.time - want) < 0.002
        );
        if (found < 0) {
          missed++;
          continue;
        }
        const cur = state.markers[found];
        const wasHidden = !(cur.comment && cur.comment.length);
        state.markers[found] = {
          time: cur.time,
          duration: cur.duration > 0.01 ? cur.duration : 0,
          comment: wasHidden ? "" : newText,
          label: cur.label || 0,
          params: { ...cur.params, voxmarkText: newText },
        };
        if (wasHidden) hiddenSkipped++;
        updated++;
      }
      return JSON.stringify({
        success: true,
        updated,
        hiddenSkipped,
        missed,
      });
    }

    if (s.startsWith("removeMarkersAtTimes(")) {
      if (!state.activeComp) {
        return JSON.stringify({ error: "No active composition." });
      }
      const argsJson = `[${s.slice("removeMarkersAtTimes(".length, -1)}]`;
      const [timesJson, tol] = JSON.parse(argsJson);
      const times = JSON.parse(timesJson);
      const t = Number(tol) || 0.05;
      let removed = 0;
      for (let k = state.markers.length - 1; k >= 0; k--) {
        const kt = state.markers[k].time;
        if (times.some((tm) => Math.abs(kt - tm) <= t)) {
          state.markers.splice(k, 1);
          removed++;
        }
      }
      return JSON.stringify({ success: true, removed });
    }

    // 7. Read markers
    if (s.includes("var mp = comp.markerProperty")) {
      return state.markers.map((m, idx) => {
        const voice = m.params?.voxmarkVoice ? String(m.params.voxmarkVoice) : "";
        const fullText = m.params?.voxmarkText ? String(m.params.voxmarkText) : "";
        return {
          index: idx + 1,
          time: m.time,
          duration: m.duration,
          comment: m.comment,
          label: m.label,
          params: { ...m.params },
          voxmarkVoice: voice,
          voxmarkText: fullText,
          voice,
          fullText,
        };
      });
    }

    return null;
  }

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ ok: false, error: { kind: "auth", message: "Unauthorized" } })
      );
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          startedBy: "service",
          busy: false,
          queueDepth: 0,
          aeVersion: "26.0",
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/eval") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        state.requests.push(body);
        try {
          const out = handleScript(body.script, body.raw === true);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              id: body.id || "req_1",
              ok: true,
              result: out,
              durationMs: 1,
            })
          );
        } catch (err) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              id: body.id || "req_1",
              ok: false,
              error: { kind: "runtime", message: err.message },
            })
          );
        }
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });

  return {
    state,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          resolve(addr.port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

describe("QA harness unit & integration tests", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-qa-test-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads token from file and talks to /health, /eval and raw /eval", async () => {
    const tokenFile = path.join(tmpDir, "token");
    fs.writeFileSync(tokenFile, `${TEST_TOKEN}\n`, "utf8");
    assert.equal(readToken(tokenFile), TEST_TOKEN);
    assert.ok(resolveTokenPath(tokenFile).endsWith("token"));

    const bridge = createMockAeBridge();
    const port = await bridge.listen();
    try {
      const client = createClient({ port, tokenPath: tokenFile });
      const h = await client.health();
      assert.equal(h.ok, true);
      assert.equal(h.aeVersion, "26.0");

      const rawOut = await client.evalFile(
        "H:/Github_repos/AFX-VoxMark/src/jsx/hostscript-aeft.jsx",
        { skipExistsCheck: true }
      );
      assert.equal(rawOut, "undefined");
      assert.equal(bridge.state.requests[0].raw, true);
      assert.deepEqual(bridge.state.loadedFiles, [
        "H:/Github_repos/AFX-VoxMark/src/jsx/hostscript-aeft.jsx",
      ]);
    } finally {
      await bridge.close();
    }
  });

  it("enforces project isolation rules and never closes a non-QA project", async () => {
    // Pure predicate checks
    assert.equal(isSafeProjectState({ projectPath: "", numItems: 0 }), true);
    assert.equal(isSafeProjectState({ projectPath: "<unsaved>", numItems: 0 }), true);
    assert.equal(isSafeProjectState({ projectPath: "", numItems: 2 }), false);
    assert.equal(
      isSafeProjectState({
        projectPath: "G:\\Dropbox\\Projects\\ClaudeProjects\\VoxMark\\_work\\qa\\test.aep",
        numItems: 12,
      }),
      true
    );
    assert.equal(
      isSafeProjectState({
        projectPath: "H:/Projects/ClientJob/MainEdit.aep",
        numItems: 5,
      }),
      false
    );

    // Refuses to start when a non-QA project is open
    const unsafeBridge = createMockAeBridge({
      projectPath: "H:\\ClientWork\\Important.aep",
      numItems: 4,
    });
    const port = await unsafeBridge.listen();
    try {
      const client = createClient({ port, token: TEST_TOKEN });
      await assert.rejects(
        () => assertSafeInitialProject(client),
        (err) => err instanceof IsolationError
      );
      await assert.rejects(
        () => resetQaProject(client),
        (err) => err instanceof IsolationError
      );
      assert.equal(unsafeBridge.state.closeCalls.length, 0);
    } finally {
      await unsafeBridge.close();
    }

    // Also refuses when an unsaved project has items (numItems > 0) and wasn't created by QA
    const dirtyUnsavedBridge = createMockAeBridge({
      projectPath: "",
      numItems: 1,
      qaOwned: false,
    });
    const port2 = await dirtyUnsavedBridge.listen();
    try {
      const client2 = createClient({ port: port2, token: TEST_TOKEN });
      await assert.rejects(
        () => assertSafeInitialProject(client2),
        (err) => err instanceof IsolationError
      );
      assert.equal(dirtyUnsavedBridge.state.closeCalls.length, 0);
    } finally {
      await dirtyUnsavedBridge.close();
    }
  });

  it("assert.js validates markers, layers, items, pixels, and frame-tolerant timing", () => {
    const t = createAssertContext({ fps: 25 });
    t.equal(1, 1);
    t.notEqual(1, 2);
    t.deepEqual({ a: [1, 2] }, { a: [1, 2] });
    t.timeClose(1.01, 1.0, { frames: 0.5, fps: 25 }); // 0.5/25 = 0.02s
    t.layerOrder([{ name: "VO" }, { name: "Music" }], ["VO", "Music"]);
    t.itemsContain([{ name: "Comp 1" }, { name: "VO.wav" }], ["VO.wav"]);
    t.pixelClose([120, 200, 40], [122, 198, 41], 4);

    assert.throws(
      () => t.timeClose(1.1, 1.0, { frames: 0.5, fps: 25 }),
      QaAssertionError
    );
  });

  it("runs VoxMark scenarios 1 to 3 end-to-end and writes JUnit XML + Markdown reports", async () => {
    const bridge = createMockAeBridge({ projectPath: "", numItems: 0 });
    const port = await bridge.listen();
    const outDir = path.join(tmpDir, "out");

    try {
      const client = createClient({ port, token: TEST_TOKEN });
      const summary = await runSuite({
        client,
        outDir,
        suiteName: "voxmark-qa",
        scenarios: [
          { scenario: scenario01, file: "01-markers-speakers.mjs" },
          { scenario: scenario02, file: "02-edit-in-place.mjs" },
          { scenario: scenario03, file: "03-selective-purge.mjs" },
        ],
        skipExistsCheck: true,
      });

      assert.equal(summary.passed, true);
      assert.equal(summary.scenarios.length, 3);
      assert.equal(bridge.state.newProjectCalls, 3);
      assert.equal(bridge.state.loadedFiles.length, 3);
      assert.ok(fs.existsSync(summary.junitPath));
      assert.ok(fs.existsSync(summary.markdownPath));

      const xml = fs.readFileSync(summary.junitPath, "utf8");
      assert.match(xml, /tests="3" failures="0"/);
      assert.match(xml, /VoxMark 01: markers and speaker colours/);
      assert.match(xml, /VoxMark 02: edit in place/);
      assert.match(xml, /VoxMark 03: selective purge/);

      const md = fs.readFileSync(summary.markdownPath, "utf8");
      assert.match(md, /\*\*Passed:\*\* 3/);
      assert.match(md, /\| VoxMark 01: markers and speaker colours \| PASS \|/);
    } finally {
      await bridge.close();
    }
  });
});
