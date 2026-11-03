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
- **Bound every list** (500 entries, `truncated: true`) **and every string** (20k).

## Definition of done for your task
- Code compiles under the strict tsconfig.
- Your tests are written.
- Your `.jsx` passes the lint rules above.

You cannot run shell commands. Write carefully, then output only:
- the files you wrote;
- the host-function names you added;
- the tool names you added;
- open questions.
