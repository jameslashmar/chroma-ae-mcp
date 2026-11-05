# Brief for parallel builders (read fully before writing code)

You are one of several builders working **at the same time** in this repo. To avoid conflicts, write **only the files named in your task**. Never edit:
- `server/src/{index,mcp-rpc,panel-entry,jsx,bridge,host,panel-host,schema}.ts`
- `server/src/tools/{read,mutate,render,quarantine,common,registry}.ts`
- `server/src/tools/ext/index.ts` (Claude registers your group)
- `panel/host/core.jsx`

Exception: an edit your task names explicitly.

## How a tool group plugs in
- **ExtendScript side:** `panel/host/ext/<group>.jsx`. The service loads it after `core.jsx`.
  - Attach functions to the existing object: `(function(G){ var A = G.__chromaAe; A.myFn = function(args){...}; })($.global);`
  - Each function takes ONE args object and returns a plain serialisable object.
  - Reuse the helpers that `core.jsx` exposes on `A`: `A.withUndo(label, fn)`, `A.stringify`, `A.checkGuard`, `A.formatError`, `A.plainResult(value)` (a script's return value as plain data; AE objects become summaries such as `[TextLayer "Title" #26]`).
  - `core.jsx` keeps `assertGuard`, `requireComp`, `findLayer`, `resolvePath`, `serialiseValue` and `describeProp` private. Re-implement small equivalents inside your file, or read `core.jsx` and copy them.
  - Throw guard errors as an `Error` with `e.__kind = "guard"` plus `e.__actual` / `e.__expected` (see `fail()` in `core.jsx`).
- **Server side:** `server/src/tools/ext/<group>.ts` exports `export const <group>Tools: ToolDefinition<any>[]`, with the same shape as `tools/read.ts` and `tools/mutate.ts`.
  - Call host functions with `ctx.bridge.callHost("myFn", args, {label, mutates, toolName})`.
  - For guarded mutations, copy the pattern in `tools/mutate.ts`:
    - `ctx.quarantine.assertClear()`;
    - `ctx.queue.run(...)`;
    - `verifyTargetGuard` (import it from `../mutate.js`);
    - `autoCheckpoint(ctx, guard, "<tool name>")` right after the guard, with its result returned as `checkpoint`. Add the tool to `AUTO_CHECKPOINT_TOOLS` in `ext/receipts.ts`;
    - a before read → the write → an after read in a **separate** `evalRaw`;
    - `buildReceipt`.
  - Every mutating tool takes `expect: ExpectSchema` (from `../common.js`), and its description ends with `AGENT_SAFETY_GUIDANCE`.
  - `runGuardedWrite` in `ext/write-runner.ts` does all of the above in one call: give it the read, the write and the checks. The 0.4 tools use it; prefer it for new ones.
  - **A write Ctrl+Z cannot undo** (`Project.replaceFont`, a saved render template) passes `undoable: false` to `runGuardedWrite`. It is still logged as an agent write and the baseline is kept, but the session tracker does not list it as an undo step, so `ae_session_changes` does not tell the user to press Ctrl+Z for it. Say so in the result (`undoable: false`) and in the description, and take a checkpoint first when a checkpoint can restore it (`ae_fonts` replace refuses without one).
  - **Once the write's evalScript has returned, never throw.** The change is in the project; a bare error makes the caller resend it. Put a failed read-back or check into the receipt with `readAfterWrite` / `checkAfterWrite` / `readBackMismatch` from `tools/read-back.ts` (runGuardedWrite does this for you). Read the write's own result from the top level of runGuardedWrite's return, not through `present`, which is skipped when the read-back fails.
  - **Validate before `A.withUndo`.** `A.withUndo` only closes the group; it doesn't undo a half-done write. Check every type, length, selector and value first, including a property's hard limits (`hasMin`/`minValue`, `hasMax`/`maxValue`: AE throws "out of range" mid-write) and separated dimensions. Also refuse, before the group, a **locked layer** (unless the tool has an explicit unlock option that locks it again in the same call), a **keyframed property** when the write is a plain `setValue`, and a missing sub-property.
  - **A host that changed nothing returns `no_op: true`.** It opens no undo group, and `runGuardedWrite` then records no undo step for it. Return it only when nothing was written.
  - **Slow writes:** a `HostCall` takes `timeoutMs` (use `SLOW_TIMEOUT_MS` from `host.ts` for renders, snapshots of big comps, hundreds of keys). It only sets how long the server waits for the panel; the evalScript in AE is never aborted.
  - **A read that has to render a changed copy of the comp is a guarded write.** `isolate_layers` / `isolate` / `hide_layers` (a temporary comp showing only the plate, with the patch off, or with the listed layers off) adds and removes a comp: two undo groups. So the tool takes `expect`, checks the quarantine and the guard, takes a checkpoint, registers with the session tracker (`noteBeforeWrite` / `noteAfterWrite`), and returns a failure receipt instead of throwing. Use `withIsolatedPlate` (`ext/planar.ts`): it removes the copy in a `finally`, reports a failed removal, and leaves nothing named `_chroma_plate_...` behind. Without the option the same tool must change nothing at all.
  - **Writes are logged per project.** The session tracker (`ext/session.ts`) keeps every agent write for a project (`agentWritesSince(projectPath, since)`), guarded or not (a write that threw, or to an unknown project, is not logged), and a snapshot to diff the user's changes against. `runGuardedWrite` feeds it. A tool that bypasses it with `evalRaw` and `mutates: true` is still logged by the bridge hook, but add the tool to the guarded path if you can.
  - **A tool that closes or reopens a project** (open, new, close, revert, collect-and-relink) must call `getSessionTracker()?.markReopened()`, inside a try that swallows errors, so earlier undo steps are reported as gone. Do it when the call throws or times out too: the project may already be closed.
  - **Shared compositing code (wave 4).** The compositing groups import from `ext/planar.ts`, `ext/planar-math.ts` and `ext/region-math.ts` instead of copying them: `loadTrack` / `saveTrack` / `resolveTrackSource`, `withIsolatedPlate`, `resolveEffectParams` (undocumented effect parameters by English display name, with an index fallback; return the table used), `blurrinessFromSigma`, `platesFolderFor`, `createRenderBudget`, `layerSpaceMatrices`, `trackSummary`, `drawTrackSheet`, `RegionSchema`, `TrackSourceSchema`, `PlanarError`; the homography, region, ring and noise maths are pure and unit-tested. `captureCompFrame` (`ext/frames.ts`) renders one frame with the stale-frame retry.
  - **Effect order on a patch layer.** Effects the tools did not add stay in front; the tools' own effects go in the order colour, degrain, blur, pin, motion blur (`EFFECT_CATEGORIES` in `planar.jsx`; add a new effect's match name there). After `addProperty`, call `A.planarEffectSlot({comp_id, layer_index, layer_id, category, new_index})` with `new_index` set to the `propertyIndex` of the effect just added, or the new effect counts itself and the slot comes out one too high; then `moveTo` it and look the effect up again. An effect not in the table counts as not added by a tool.
  - **Host contract.** The planar host functions are `planarIsolateBegin` / `planarIsolateEnd`, `planarLayerSpace`, `planarWriteRaw` (validates, then writes, opens no undo group: the caller wraps it), `planarApply`, `planarRead`, `planarEffectSlot`, `planarKeys`, `planarComp`. Ext `.jsx` files load in file-name order, so call another file's `A.*` function at call time, never at load. A host test that calls `planarWriteRaw` or `planarEffectSlot` loads `["planar.jsx", "<group>.jsx"]`.
  - **Render budgets and continue ids.** A tool that renders a frame per sample takes `max_renders` / `max_seconds` (or `max_frames`), counts them with `createRenderBudget`, and never holds the queue for minutes. When the budget runs out it says `sampled N of M frames` (a read), or it returns a continue id (`continue_track_id` for `ae_track_multi`, `continue_id` for `ae_patch_color_match`) with its state stored under the data dir (`tracks/`, `patchfit/`, newest kept); the call that finishes writes. Every continued call must make progress: always do at least one unit, even if the budget is already spent.
  - **Never overwrite what is stored.** A stored track is the user's: re-basing it on another `ref_time` saves a copy under a new `track_id` and leaves the original. Files in `<project> chroma plates/` are never overwritten (`uniquePath`, `uniqueStillPath`, `flag: "wx"`); a taken name gets `_2` (inpaint) or ` 2` (stills). Make the folder only after the guard has passed, so a wrong `expect.project_path` creates nothing.
- **Tests:** `server/test/ext-<group>.test.ts` (vitest). Use a fake `HostTransport` (see `test/panel-host.test.ts`) to check schemas, the guard and receipt flow, and any pure logic.
  - The `.jsx` itself can run under `node:vm` against `test/support/fake-ae.ts`, a small simulated AE DOM (`loadHost(project, ["yourgroup.jsx"])`; see `host-jsx.test.ts`). Extend the fake where your code needs more of AE, following AE's behaviour. It catches ES3 and logic slips; it doesn't replace the live smoke test.

## Rules measured on AE 26 (breaking them is a bug)
- **ES3 only in `.jsx`:** no `let`/`const`/arrows/template strings/classes. **Never chained ternaries.** Use if/else. `scripts/lint-jsx.mjs` enforces this.
- **Undo groups** begin and end inside the same function call (`A.withUndo`). Renders, saves, opening projects and file I/O are not undo-grouped.
- **Read tools must not change the project or comp state at all,** including `resolutionFactor`, selection, active item, time or solo: anything they change lands on Jay's undo stack.
- **Read back in a separate evalScript.** A read in the same script as the write returns stale values.
- **`saveFrameToPng` writes asynchronously.** Wait for the file on the Node side (see `waitForFreshPng` in `tools/render.ts`).
- **`app.executeCommand` DOES work through CEP for Window-menu commands** (measured 2026-10-27, AE 26.0: `findMenuCommandId("Effects & Presets")` = 3718 reopened the panel). This contradicts Engine-Room's note. Window commands **toggle**, so check the state first. Other commands are untested.
- **Adding an effect invalidates references to the others on that layer** (measured 2026-10-29, AE 26.2.1: "Object is invalid" on a Keylight reference after adding Key Cleaner). Read what you need (`propertyIndex`, values) before the next `addProperty`, or look the effect up again.
- **Look properties up again after `addProperty`** (generalises the effect rule above; found again in text animators, shape operators and Dropdown Controls). Any reference to a sibling, or to a group's earlier children, can go stale. Read what you need first, or re-resolve from the layer by index or match name before each step. Do not hold a `Property` across an `addProperty`, `remove()` or `setPropertyParameters`.
- **Declare every variable a callback uses.** An undeclared name is a global in ExtendScript: reading one that was never set throws a ReferenceError, and writing one leaks into the next call. This usually hides in a rollback or failure path that only runs on error (found in the stagger layout rollback). Declare the `var` at the top of the function, including the failure list a rollback fills, and test the failure path.
- **Effect section headers share names with parameters** (Colorama's "Output Cycle", Fractal Noise's "Transform"): `property(name)` can return the valueless header. Address effect parameters by match name.
- **Custom-data parameters** (`PropertyValueType.CUSTOM_VALUE`, e.g. Colorama's Output Cycle) can't be read or set by script ("has not been implemented"). An expression linking to the same parameter on another effect does work, and so do presets.
- **2D layers keep three-dimensional Scale and Position** (measured 2026-10-30, AE 26.2.1): setting Scale to `[100, 75]` works and reads back as `[100, 75, 100]`. Compare only the dimensions you set.
- **A duplicated comp's layers get new ids** but keep their indexes, so resolve a layer in the original and use its index in the copy (`ae_build_from_data`, `ae_reframe`).
- **Changing a comp's `width` and `height` leaves every layer at the same pixel position** from the top-left corner: content shifts off-centre unless you move it (what `ae_reframe` does).
- **Audio-only layers still have a Transform group** in scripting (measured 2026-10-30, AE 26.2.1; `hasVideo` is false), and **a separated Position still reads as one value** through `ADBE Position`. `layer.trackMatteLayer` exists on AE 26.
- **Polling evals stay out of the log:** the service doesn't log an eval whose label starts with `quiet:` unless it fails (the asset watcher's status checks). Use it only for background polling; anything that writes must log.
- **Never suppress AE dialogs** (no `app.beginSuppressDialogs`). Jay's rule: popups are read and answered through `ae_dialogs` / `ae_dialog_respond`, never hidden.
- **Node code that runs in the panel** (anything reachable from `panel-entry.ts`) must work on **Node 17.7.2**: no `fetch`, no `Headers`, no `AbortSignal.timeout`, no `structuredClone`, no native modules. Pure-JS deps only.
- **Child processes:** `windowsHide: true` always. Never block the eval queue waiting on a long process; run it as a background job with a status tool.
- **Bound every list** (500 entries, `truncated: true`) **and every string** (20k). When a read is capped, say so, and don't let a capped read make a receipt flag a correct write or a dry run under-count.
- **`property()` returns null for a missing property** rather than throwing: test for null as well as catching.
- **Image sequences import with Force alphabetical order off** (`ImportOptions.forceAlphabetical = false`, `replaceWithSequence(file, false)`): numbered order, with placeholders for missing frames, as AE's Import dialog does by default.

## Precautions (not measured on AE)
Rules the code follows because AE may behave this way. Nobody has seen it fail; the first live run may show they are not needed.
- **`.jsx` is ASCII only,** comments and strings included (`scripts/lint-jsx.mjs` fails on any other character). Not measured, a precaution: ExtendScript may read the file in the system code page, and U+2028 / U+2029 end a string literal in ES3. Write `é`-style escapes, and plain `-` and `'` in comments.
- **Keep the Scripting Guide's enum constants out of `String()`.** Not measured, a precaution: they are enum objects or numbers, and `String()` of one need not give the name; AE's enum objects may list no keys for `for..in`. Map a value to its name through the enum's global object with a list of known names to try (`enumNameOf` in `core.jsx`, `enumName` / `enumValue` in `projectsettings.jsx` and `animate.jsx`), refuse a name the build does not have and list the members it does, and fall back to the raw value. Do not hard-code number tables. (The TextDocument fields `core.jsx` has always returned, such as `justification`, still go through `String()`.)

## Definition of done for your task
- Code compiles under the strict tsconfig.
- Your tests are written.
- Your `.jsx` passes the lint rules above.

You cannot run shell commands. Write carefully, then output only:
- the files you wrote;
- the host-function names you added;
- the tool names you added;
- open questions.
