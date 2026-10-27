# chroma-ae-mcp: spec

An MCP server that lets Claude Code drive Adobe After Effects 2026 (AE 26.x, CEP 12, Windows first,
macOS second) through a thin, guarded listener. It is an internal Chroma dev tool, not a product.

Design rule: **AE's ExtendScript DOM is complete, so we do not wrap it in hundreds of tools.**
One guarded `ae_run_jsx` plus a few typed reads and writes. Every mutation is guarded against the
wrong project or comp, wrapped in one undo group, and verified by a *separate* read-back call.

Reference code (MIT, read-only, gitignored) is in `reference/`. Borrow ideas and small pieces with
attribution in `ATTRIBUTION.md`; do not copy whole files.
- `reference/engine-room/docs/fragile-areas-ae.md` and `fragile-areas-bridge.md`: **read first.**
  Measured AE 26 behaviour. Key facts:
  - an undo group opened in one evalScript and closed in another is discarded, so begin and end in the same call;
  - reads in the same script as a write return stale values, so read back in a separate evalScript;
  - `saveFrameToPng` can return an old buffer while reporting success;
  - `app.executeCommand` silently does nothing through CEP;
  - `$.evalFile` evaluates in the caller's scope;
  - ExtendScript parses chained ternaries left-associatively, so use if/else, never `a ? b : c ? d : e`.
- `reference/engine-room/packages/jsx/core.jsx`: undo-group counter and `withUndo`. `raw.jsx`: maps error lines back to the submitted script. `snapshot.jsx`: state for diffs.
- `reference/engine-room/packages/ae-panel/client/main.js`: serialised evalScript in the panel.
- `reference/engine-room/packages/mcp-server/src/bridge/writeQueue.ts` and `httpClient.ts`: single writer; separate timeout, unreachable and queued errors.
- `reference/junkdoge/plugin/host/jsx-bridge.js`: drain-sentinel timeout. **Never abort an in-flight evalScript** (killing one wedges the ExtendScript bridge). Block the queue until AE answers again.

## Layout

```
server/            TypeScript MCP server (Node 20+, ESM, @modelcontextprotocol/sdk, zod), stdio transport
  src/index.ts       registers tools, starts stdio
  src/bridge.ts      HTTP client to the panel
  src/queue.ts       single-writer queue
  src/quarantine.ts  uncertain-write state
  src/receipts.ts    before/after comparison helpers
  src/jsx.ts         builds the JSX call strings (escaping)
  src/tools/*.ts     one file per tool group
  test/*.test.ts     vitest
panel/             CEP 12 extension, id london.chroma.aemcp, a small visible panel (status + log)
  CSXS/manifest.xml  AE (AEFT) [25.0,99.9], CEP 12, --enable-nodejs, --mixed-context
  client/index.html, client/main.js, client/style.css
  host/core.jsx      the __chromaAe host library (loaded once at panel start)
scripts/
  install-dev.ps1    junctions panel/ into %APPDATA%\Adobe\CEP\extensions\london.chroma.aemcp and sets
                     HKCU\Software\Adobe\CSXS.12 PlayerDebugMode=1
  lint-jsx.mjs       fails on chained ternaries in panel/host/*.jsx
README.md, CLAUDE.md, ATTRIBUTION.md, .gitignore (node_modules, dist, reference/)
```

## Bridge protocol (server <-> panel). Both sides must match exactly.

- The panel runs a Node `http` server on `127.0.0.1:7790` (env `CHROMA_AE_MCP_PORT` on the server; a panel setting otherwise).
- **Token:** at start the panel generates 32 random bytes (hex) and writes them to
  `%LOCALAPPDATA%\chroma-ae-mcp\token` (macOS: `~/Library/Application Support/chroma-ae-mcp/token`),
  folder mode 0700 and file mode 0600. On Windows it restricts the folder ACL with `icacls` to the current user,
  spawned with `windowsHide: true`. The server reads the token file on every connect attempt.
- Every request needs `Authorization: Bearer <token>`. Reject any request carrying an `Origin` header (browser), and any request whose Host is not `127.0.0.1:<port>`.
- `GET /health` returns `{ok:true, busy:bool, queueDepth:int, aeVersion:string, panelVersion:string, inFlight:{id, startedAt}|null}`.
- `POST /eval` takes JSON `{id:string, script:string, label:string}` and returns `{id, ok:true, result:any, durationMs}` or `{id, ok:false, error:{message, line?, kind}}`.
  - The panel wraps `script` so that it runs inside `(function(){ try { return JSON-encoded {ok,result} } catch(e) { return JSON-encoded {ok:false,error} } })()`.
  - It uses the JSON stringifier from core.jsx, not `JSON` (ExtendScript has none).
  - It parses the evalScript string result with `JSON.parse` (never `eval`).
- **The panel serialises:** one evalScript at a time, a FIFO queue, each item resolving its HTTP response when its callback fires.
  - The panel **never times out or aborts** an evalScript.
  - If a request waits more than 600 s for its turn, it gets `{ok:false, error:{kind:"queued"}}`.
  - The panel UI shows the in-flight label and the queue depth.
- `EvalScript_ErrMessage` as the result string gives `kind:"evalscript_error"`.

## Server behaviour

- **Single writer:** all calls go through one queue (reads too, because AE is single-threaded).
- **Timeouts:** the default is 120 s, or 600 s for render/save/snapshot.
  - On timeout the server answers the tool call with `kind:"timeout"` and an "outcome unknown" message.
  - It does **not** resend.
  - If the call was a mutation, the op id goes into quarantine.
- **Quarantine:** while any op is quarantined, every mutating tool refuses with the op id and instructions.
  - To clear it: call `ae_status` (which shows the panel's `/health`), inspect the state with read tools, then `ae_acknowledge` `{op_id, note}`.
  - Read tools still work.
  - Quarantine is in memory, mirrored to `%LOCALAPPDATA%\chroma-ae-mcp\quarantine.json` so it survives a server restart.
- **Unreachable panel:** error kind `unreachable`, with a hint to open Window > Extensions > Chroma AE MCP.
- **Target guard:** every mutating tool requires `expect: {project_path: string, comp_id?: number}`.
  - The JSX checks `app.project.file` (null means unsaved, which refuses unless `project_path === "<unsaved>"`) and compares paths after normalising: on Windows, case-insensitive with backslashes turned to `/`.
  - If `comp_id` is given, `app.project.itemByID(comp_id)` must be a CompItem.
  - On mismatch it refuses **before** doing anything, with `kind:"guard"` and the actual values.
- **Receipts:** a mutating tool returns `{op_id, applied:true, receipt:{before, after, matches:bool, mismatches:[...]}}`.
  - `after` always comes from a separate evalScript issued after the write returns.
  - `matches:false` is a normal result, not an exception; the agent decides what to do.
- **Undo:** every mutation runs inside `app.beginUndoGroup(label)` / `app.endUndoGroup()` within the **same** evalScript (core.jsx `withUndo`, with a nesting counter), so Jay can Ctrl+Z it as one step. Renders and saves are not undo-grouped.
- Output is bounded: lists cap at 500 entries with `truncated:true`, and strings cap at 20k characters.

## Tools (names are fixed)

| Tool | Kind | Input | Output |
|---|---|---|---|
| `ae_status` | read | none | panel health, AE version, project path (or `<unsaved>`), dirty flag, active comp `{id,name}`, selected layers, quarantine list |
| `ae_get_project` | read | `{folder_id?, depth?=3}` | item tree: id, name, typeName, parent folder id; comps add width, height, fps, duration; footage adds file path |
| `ae_get_comp` | read | `{comp_id}` | comp settings, work area, and layers (index, name, id, type, in/out, parent, enabled, solo, locked, label, 3D, blending mode, track matte) |
| `ae_get_layer_props` | read | `{comp_id, layer:{index?|name?|id?}, path?:string[], depth?=2}` | property tree with matchName, name, value (serialised), numKeys, expression, expressionEnabled |
| `ae_run_jsx` | read or mutate | `{code, mutates:bool, label, expect?}` | `{result}`. `expect` is required when `mutates`. When `mutates`, the before/after snapshot of `expect.comp_id` (or the project summary) forms the receipt. `code` is the body of a function; its `return` value is the result. Errors map back to the line in `code`. |
| `ae_set_property` | mutate | `{comp_id, layer, path:string[], value? , keyframes?:[{time,value,interp?}], expression?, expect}` | receipt comparing requested with read-back |
| `ae_snapshot_frame` | read | `{comp_id, time, scale?=0.5}` | a PNG path in `%LOCALAPPDATA%\chroma-ae-mcp\frames\`. The name is unique per call. Verify the file's mtime is newer than the request and its size > 0; if not, retry once with a different time nudge, then report `stale_frame` |
| `ae_render_queue_add` | mutate | `{comp_id, output_path, output_module_template?, render_settings_template?, expect}` | the RQ item index, with a receipt |
| `ae_render_queue_status` | read | none | items: comp, status, output paths |
| `ae_save` | mutate | `{expect, backup?:bool=true}` | `app.project.save()`. If `backup`, the **server** (not AE) first copies the existing .aep with Node fs to `<project dir>/_mcp_backups/<name>_<yyyyMMdd-HHmmss>.aep`, and returns both paths and sizes. Never use save-as for backups: it retargets the open project. |
| `ae_quarantine_status` | read | none | the list |
| `ae_acknowledge` | control | `{op_id, note}` | removes it from quarantine |

Tool descriptions must tell the agent:
- re-read before writing;
- long synchronous loops freeze AE's UI;
- Jay may be editing live, so a guard failure means stop and re-read, not retry.

## Non-goals (v0.1)
UXP, macOS signing, typed wrappers for text and shape layers, effects catalogue, ZXP packaging, licensing.

## Definition of done
- `npm run build` and `npm test` pass in `server/`.
- `node scripts/lint-jsx.mjs` passes.
- A live smoke test in AE 26 (done by Claude/Jay afterwards):
  - status;
  - get_comp;
  - set a layer's opacity with the guard, then check the receipt;
  - Ctrl+Z restores it;
  - a wrong `project_path` is refused;
  - a snapshot frame gives a fresh PNG.
