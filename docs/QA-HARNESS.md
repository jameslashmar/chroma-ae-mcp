# QA harness: automated AE tests for VoxMark and Gulp

Goal: run each product's real ExtendScript in a real After Effects, against generated fixtures, and get a pass or fail with evidence. Today both products have offline unit tests only. Their host code (`hostscript-aeft.jsx`) is checked by hand.

The harness reuses chroma-ae-mcp's bridge:
- the service extension's HTTP endpoint and token;
- the never-abort eval queue;
- separate read-back;
- `saveFrameToPng` with the async wait.

It adds scenarios, fixtures, isolation and reports.

## Shape

```
chroma-ae-mcp/qa/            the runner (Node 20, no AE-specific deps)
  client.js                  talks to the service: /eval, /health (token from the token file)
  runner.js                  loads scenarios, isolates, runs, reports
  fixtures.js                generates media with the global ffmpeg/oiiotool, cached by hash
  assert.js                  markers, layers, items, frame pixels, timing (with frame tolerance)
  report.js                  JUnit XML + a markdown summary with snapshot links

AFX-VoxMark/qa/scenarios/*.mjs   product-owned scenarios
AFX_Gulp/qa/scenarios/*.mjs
```

Run it from a product repo: `node ../chroma-ae-mcp/qa/runner.js qa/scenarios`. Claude can run it the same way, and so can a self-hosted CI runner later.

A scenario is a small module:

```js
export default {
  name: "VoxMark: markers and speaker colours",
  fixtures: { comp: { w: 1920, h: 1080, fps: 25, seconds: 10 } },
  load: ["src/jsx/hostscript-aeft.jsx"],          // product code from the working tree
  async run(ae) {
    await ae.call("createCompMarkers", [JSON.stringify(TWO_SPEAKERS), 0, true]);
  },
  async assert(ae, t) {
    const m = await ae.read.markers();             // a separate evalScript
    t.equal(m.length, 4);
    t.equal(m[0].comment, "[Ana] Hello there");
    t.equal(m[0].label, VOXMARK_LABEL_CYCLE[0]);
  },
};
```

## Rules that come from what we measured

1. **Load product code at global scope.** `$.evalFile` evaluates into the caller's scope, and Gulp's `gulp*` functions would vanish inside our function wrapper. So the client needs a raw `/eval` mode with no wrapper, or it does `$.global.eval(file.read())`. Test this first.
2. **Isolation must not touch Jay's work.** The runner refuses to start unless AE has an unsaved, empty project or a project under the QA folder open. Each scenario makes a fresh project:
   - `app.newProject()` only after closing the previous QA project with `CloseOptions.DO_NOT_SAVE_CHANGES`;
   - never on a non-QA path.

   Better still, run it in a **separate AE instance**, or on a QA machine.
3. **Read back separately** from the action, as the MCP does. Reads in the same script are stale on AE 26.
4. **Frames:** wait for the PNG to finish writing (it's written asynchronously), and never change `resolutionFactor`.
5. **`app.executeCommand` works from CEP for Window-menu commands** (measured 2026-10-27). Engine-Room said it does nothing. Gulp's `gulpTriggerMultipass` relies on it for an AEGP command, so the first Gulp scenario should *measure* whether that works from CEP. Gulp works in production, so it may behave differently for commands an AEGP registers.
6. **Never suppress dialogs** (Jay, 2026-10-27). AE shows its popups as normal. A popup that blocks a scenario is read with `ae_dialogs` and recorded in the report (title, text, buttons, screenshot). The scenario fails unless it explicitly expected that dialog and answered it with `ae_dialog_respond`. Never kill the eval.

## Fixtures (generated, not committed)
| Need | How |
|---|---|
| A VO WAV, 16 kHz mono, with known speech timing | ffmpeg `sine` or `anoisesrc` bursts at known times (for onset tests); ElevenLabs TTS for a real-speech set, generated once and cached in `_work/qa-fixtures` |
| SRT/VTT transcripts with speakers | Inline in the scenario. VoxMark already has `TOUR_SAMPLE` and the `verify-panel.cjs` SRT |
| An EXR sequence (single and multichannel AOVs, gaps) | oiiotool `--pattern` and `--ch` (the Archiver's tests already do this) |
| PSD, AI, a missing-media project | Gulp's `test-assets/` (AI exists); generate a PSD with layer groups once; a missing-media project = import, then rename the source |

## First scenarios
**VoxMark**
1. Markers and speaker colours: `createCompMarkers`, then check the count, comments, labels and the hidden `voxmarkVoice`.
2. Edit in place: `updateMarkerTextAtTime` changes one marker's comment and `voxmarkText`, and leaves the rest alone.
3. Selective purge: `removeMarkersAtTimes` removes only the transcript markers; a user marker survives.
4. Solo scan and render offset: `getCompInfo` sees only the soloed VO, and `renderCompAudioToFile` starts at the layer offset with an empty render queue afterwards.
5. Tour timeline lifecycle: create, then remove, and the previous comp is restored.

**Gulp**
1. Shot assembly from AOVs: `gulpBuildShotComp` checks layer order, blend modes, duration and fps, plus a frame snapshot.
2. A sequence with gaps: `gulpImportOne` checks the duration span and the missing-frame report.
3. Batch relink: `gulpRelinkFootage` leaves `footageMissing` false everywhere, with no failures.
4. Tidy: after `gulpTidyApply`, the root holds only the canonical bins and no dependency is broken.
5. Measure the multipass command: `gulpTriggerMultipass` through CEP. Record what happens.

## UI-level checks
Panel flows go through CDP, as VoxMark's `scripts/verify-panel.cjs` already does: AE 8098 and Premiere 8099. The harness can call that script as one step, so button-to-host wiring is covered too.

## CI later
GitHub-hosted runners have no AE. A **self-hosted Actions runner** on a QA machine with AE installed (PRISM, or a dedicated box) could run the scenarios on every push to VoxMark and Gulp. It should run in a separate AE instance and never on Jay's working session.

## Order of work
1. Global-scope loading (rule 1) and the isolation guard (rule 2). These are blockers.
2. The runner, client and assert library, with VoxMark scenarios 1–3. These need no media.
3. Fixture generation. Then the rest of VoxMark, and Gulp 1–4.
4. Gulp 5 (measure `executeCommand`), plus the reports.
5. The self-hosted runner.
