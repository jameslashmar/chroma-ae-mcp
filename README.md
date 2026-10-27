# chroma-ae-mcp

An MCP (Model Context Protocol) server that lets Claude Code drive **Adobe After Effects 2026** (AE 26.x, CEP 12; Windows first, macOS second) through a thin, guarded listener.

This is an internal Chroma developer tool, not a general consumer product.

> **Status: v0.1, live smoke test passed on AE 26.0 (2026-10-27).**
> - Two bugs were found and fixed in the live test: `saveFrameToPng` writes asynchronously (the server now waits), and snapshots used to change the comp's resolution, which polluted the undo stack.
> - Read tools must never change comp or project state. Anything they change lands on the user's undo stack.

---

## Scope

**In scope (v0.1)**
- After Effects 2026 (26.x) on Windows, through a CEP 12 panel. macOS should work (the paths are handled), but it is untested.
- Claude Code as the client: a local stdio MCP server talking to the panel on `127.0.0.1`.
- Working **alongside a person editing live**: every write is guarded, undoable in one step, and verified.
- Arbitrary ExtendScript through one guarded tool, plus typed reads, property and keyframe writes, frame snapshots, the render queue and save.

**Out of scope (v0.1)**
- UXP panels, ZXP packaging and signing, licensing, distribution to customers.
- Typed wrappers for text, shape or effect authoring. Use `ae_run_jsx` for these.
- Running renders. `ae_render_queue_add` queues items; rendering stays a deliberate human action (or `aerender`).
- Remote access. The listener binds to localhost only.

## Features

- **One guarded escape hatch.** `ae_run_jsx` runs any ExtendScript. Errors map back to the line of *your* script.
- **Target guard.** Every write names the project path (and comp id) it expects. If AE has something else open, the write is refused before anything changes.
- **One undo step per write.** The undo group begins and ends inside the same evalScript, so one Ctrl+Z backs out a whole operation.
- **Receipts.** Every write returns a before/after comparison, read back in a *separate* evalScript, because AE returns stale values when a read follows a write in the same script.
- **Quarantine.** A write that times out has an unknown outcome. It is quarantined, and further writes are blocked until someone inspects the state and acknowledges it. It is never retried automatically.
- **Never kills AE mid-script.** Aborting an evalScript wedges the ExtendScript bridge, so the panel queues calls and waits.
- **Single writer.** One call at a time, in order, because AE is single-threaded.
- **Fresh-frame check.** `saveFrameToPng` can return a stale buffer while reporting success, so snapshots are checked by file time and size.
- **Safe backups.** `ae_save` copies the .aep on disk before saving. It never uses save-as, which would retarget the open project.
- **Locked-down bridge.**
  - A random token is created at each panel start, in a folder only the current user can read.
  - Requests from a browser (any `Origin` header) are rejected.
  - A strict `Host` check applies, and the listener binds to localhost only.

---

## Why a Thin Guarded Listener?

Adobe After Effects provides a comprehensive, mature ExtendScript DOM. Wrapping it in hundreds of bespoke MCP tool wrappers creates an enormous, fragile surface area that drifts from AE updates.

Instead, **chroma-ae-mcp** provides a single guarded execution primitive (`ae_run_jsx`) complemented by high-frequency typed reads and safe property setters:

1. **Target Guarding (`expect`)**: Every mutating call requires the caller to specify the expected project path and comp ID. If the active AE project or comp does not match, the operation is rejected before anything changes.
2. **Atomic Undo Groups**: Every mutation runs inside a single `withUndo` group (`app.beginUndoGroup` / `app.endUndoGroup` in the **same** `evalScript` call), so Jay can undo the entire operation with a single `Ctrl+Z`.
3. **Separate Read-Back Verification**: Reads in the same script as a write return stale cached values in ExtendScript. The bridge always issues read-backs in a *separate* evalScript call, producing an objective before/after receipt.
4. **Never Abort In-Flight Calls**: Killing an active ExtendScript execution permanently wedges CEP. The queue blocks until AE answers or drains safely.

---

## Installation & Setup

### 1. Build the Server

Build the TypeScript MCP server:

```powershell
cd server
npm install
npm run build
```

### 2. Install the Extension Junction

Run the developer installation script (PowerShell 7 required):

```powershell
pwsh scripts/install-dev.ps1
```

This performs two actions:
- Creates a directory junction from `%APPDATA%\Adobe\CEP\extensions\london.chroma.aemcp` to the repo's `panel/` folder.
- Configures `HKCU:\Software\Adobe\CSXS.12 PlayerDebugMode=1` (string `'1'`) to permit unsigned development CEP extensions.

> To remove the junction later, run `pwsh scripts/install-dev.ps1 -Uninstall`.

### 3. Restart After Effects & Open the Panel

1. Restart Adobe After Effects 2026 (AE 26.x).
2. Open the extension panel:
   **Window > Extensions > Chroma AE MCP**
3. Keep the panel docked or open. The panel runs a local HTTP listener on `127.0.0.1:7790` and generates a session token.

### 4. Register with Claude Code

Register the server using Claude's MCP CLI:

```bash
claude mcp add --scope user chroma-ae -- node <repo>/server/dist/index.js
```

*(Replace `<repo>` with the absolute path to your cloned repository, e.g. `H:/Github_repos/chroma-ae-mcp/server/dist/index.js`.)*

---

## Tools

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

---

## Target Guard and Quarantine

### Target Guard (`expect`)

Every mutating tool (`ae_run_jsx` with `mutates: true`, `ae_set_property`, `ae_render_queue_add`, `ae_save`) requires an `expect` parameter:

```json
"expect": {
  "project_path": "H:/Projects/Anim.aep",
  "comp_id": 14
}
```

Before evaluating any modification:
- The JSX host verifies `app.project.file`. Unsaved projects match `"<unsaved>"`. File paths are normalized (case-insensitive, forward slashes).
- If `comp_id` is supplied, `app.project.itemByID(comp_id)` must resolve to an existing `CompItem`.
- If a mismatch occurs, execution aborts immediately with `kind: "guard"`, returning the actual project path and comp ID. **Do not retry blindly on guard failure; stop and inspect the current project state.**

### Quarantine System

ExtendScript is single-threaded. If an operation exceeds the timeout limit (120 s default, or 600 s for renders/snapshots), the server answers with `kind: "timeout"` and an "outcome unknown" error. The script may still be processing in AE's background.

1. **Quarantine Entry**: The ID of any timed-out mutation is placed into quarantine.
2. **Mutations Blocked**: While any op is quarantined, all mutating tools refuse calls with the quarantined op ID and clear instructions. Read tools (`ae_status`, `ae_get_comp`, etc.) remain fully functional.
3. **Persistence**: Quarantine state is saved to `%LOCALAPPDATA%\chroma-ae-mcp\quarantine.json` (macOS: `~/Library/Application Support/chroma-ae-mcp/quarantine.json`) so it survives server restarts.
4. **Resolution**:
   - Call `ae_status` to inspect panel health.
   - Use read tools to assess whether the timed-out script completed.
   - Clear the quarantine entry with `ae_acknowledge({ op_id, note: "Verified state manually" })`.

### Receipts and Undo Groups

- **Undo Grouping**: Every mutation is wrapped in `app.beginUndoGroup(label)` and `app.endUndoGroup()` inside the **same** evalScript execution. Extending an undo group across multiple evalScript calls causes After Effects to discard the group, cluttering history with hundreds of granular steps.
- **Verification Receipts**: Mutations return `{ op_id, applied: true, receipt: { before, after, matches, mismatches } }`. The `after` snapshot is collected in a separate, subsequent evalScript invocation to bypass AE's internal write cache.

---

## Troubleshooting

### 1. Panel Unreachable (`kind: "unreachable"`)
- **Symptom**: MCP tool calls fail immediately with an `unreachable` error.
- **Remedy**: The CEP panel must be active for the bridge to listen. Open After Effects and ensure the panel is visible: **Window > Extensions > Chroma AE MCP**. If closed, CEP is not running.

### 2. Authentication & Token Errors (HTTP 401)
- **Symptom**: the panel log shows `auth` rejections, or tools fail right after AE was restarted.
- **Remedy**: On startup, the panel generates a 32-byte hex token and writes it to `%LOCALAPPDATA%\chroma-ae-mcp\token` (macOS: `~/Library/Application Support/chroma-ae-mcp/token`) with restricted permissions (mode 0600, ACL locked to current user).
  - Verify the token file exists and is accessible.
  - The bridge rejects requests with an `Origin` header (protecting against browser drive-by attacks) and requires `Host: 127.0.0.1:<port>`.
  - Restarting After Effects creates a fresh token file.

### 3. Port Conflicts (`127.0.0.1:7790`)
- **Symptom**: Panel shows error binding port 7790, or status cannot connect.
- **Remedy**: Port `7790` is the default bridge port. You can override it by setting `CHROMA_AE_MCP_PORT` in your environment. Verify port status via:
  ```powershell
  curl http://127.0.0.1:7790/health
  ```

### 4. CEP Remote Debugging (`localhost:8097`)
- **Symptom**: Panel appears blank, throws JavaScript errors, or fails to initialize.
- **Remedy**: The extension enables CEP remote debugging on port `8097`.
  1. Open Google Chrome or Microsoft Edge.
  2. Navigate to `http://localhost:8097` (or `chrome://inspect`).
  3. Click the **Chroma AE MCP** inspection link to open Chrome DevTools for the panel, giving access to the console logs, network activity, and DOM inspector.

---

## Live smoke test (definition of done)

With a saved project open in AE 26 and the panel showing "ready":

1. `ae_status`: returns the project path and the active comp.
2. `ae_get_comp`: lists its layers.
3. `ae_set_property` on a layer's Opacity, with a correct `expect`: the receipt shows `matches: true`.
4. One Ctrl+Z in AE restores the old opacity.
5. The same call with a wrong `project_path`: refused with `kind: "guard"`, and nothing changes.
6. `ae_snapshot_frame`: returns a fresh PNG.

## Credits

Ideas and small pieces are borrowed (MIT) from
[Engine-Room-Games/after-effects-mcp](https://github.com/Engine-Room-Games/after-effects-mcp) and
[JUNKDOGE-JOE/after-effects-mcp](https://github.com/JUNKDOGE-JOE/after-effects-mcp). See `ATTRIBUTION.md`.
