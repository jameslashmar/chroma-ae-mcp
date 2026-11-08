# chroma-ae-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/jameslashmar/chroma-ae-mcp/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/jameslashmar/chroma-ae-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jameslashmar/chroma-ae-mcp?label=release&color=e34e9c)](https://github.com/jameslashmar/chroma-ae-mcp/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-3f4fa1.svg)](LICENSE)
[![After Effects](https://img.shields.io/badge/After%20Effects-2026%20(26.x)-674fa1.svg?logo=adobeaftereffects&logoColor=white)](https://www.adobe.com/products/aftereffects.html)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-43c0bc.svg)](https://modelcontextprotocol.io/specification/2025-11-25)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B%20%C2%B7%20CEP%2017.7-f37d5b.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS-f06465.svg)](#)

[![GitHub stars](https://img.shields.io/github/stars/jameslashmar/chroma-ae-mcp?style=flat&logo=github)](https://github.com/jameslashmar/chroma-ae-mcp/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/jameslashmar/chroma-ae-mcp?style=flat&logo=github)](https://github.com/jameslashmar/chroma-ae-mcp/network/members)
[![Open issues](https://img.shields.io/github/issues/jameslashmar/chroma-ae-mcp.svg)](https://github.com/jameslashmar/chroma-ae-mcp/issues)
[![Last commit](https://img.shields.io/github/last-commit/jameslashmar/chroma-ae-mcp.svg)](https://github.com/jameslashmar/chroma-ae-mcp/commits/main)

## What is this?

An MCP server that lets Claude Code, Claude Desktop, Cursor and Codex drive **Adobe After Effects 2026** (AE 26.x, CEP 12) safely, alongside a person who is editing live. It runs **inside After Effects** and starts with it, so there is no separate server to install or run.

This is an internal Chroma tool, not a consumer product.

<table>
  <tr>
    <td align="center"><img src="docs/images/panel-log-closed.png" width="240" alt="The panel with the Log closed: session tiles, a reply-time chart, Register with, and Copy setup command"><br><sub>Log closed</sub></td>
    <td align="center"><img src="docs/images/panel-log-open.png" width="240" alt="The panel with the Log open below the tiles, listing recent tool calls and checkpoints"><br><sub>Log open</sub></td>
    <td align="center"><img src="docs/images/panel-log-full.png" width="240" alt="The panel with the Log filling the whole panel"><br><sub>Log filling the panel</sub></td>
  </tr>
</table>

## What it can do

- **Read** the project, comps, layers, effects and keyframes, in bounded, paged calls.
- **Write** values, keyframes, expressions, text, footage and effects. Every write is guarded, one undo step, checkpointed and read back.
- **Look at motion**: render frames, tile them into contact sheets, graph a property's value and speed, and review a comp's animation the way an animator would, with ready easing fixes.
- **Produce versions**: one comp per CSV/JSON row, social reframes to 16:9, 1:1, 4:5 and 9:16, assets dropped in a folder imported into a bin, and saved recipes ("skills") for house rigs and lower thirds.
- **Track and key** inside AE: a sub-pixel point tracker and a measured green-screen key, with nothing extra installed.
- **Composite**: track a plane with 1 to 8 points, stabilize a shot, remove something from it (a freeze, clone or filled-in clean plate, tracked back), make the patch match the shot's colour and grain, check it over time, replace a screen, and let masks and mattes follow a track. All of it is measured from rendered frames. Content-Aware Fill, Roto Brush and Mocha have no scripting; `docs/HANDOVER.md` says what is used instead.
- **Look after the project**: make comps, tidy the Project panel, read and set Project Settings, find, check and replace fonts, find cuts in an edit, and hand the view back to the user (open, select, park the playhead).
- **Build** layers of every kind, precomps, track mattes (AE 23+ layer mattes), shape contents, masks and text animators, align and distribute, and set hundreds of properties in one undo step.
- **Work to sound**: render a comp's audio in the background and read its level, hits, tempo and beats; put markers or pulses on the beats; turn a transcript into VO markers.
- **Deliver**: check a render by importing it back, version shots up to the latest file on disk, build Essential Graphics templates and export MOGRTs, purge unused items, and check a comp against the brief's fonts, brand colours and safe areas.
- **Ask the user** in the panel, with buttons, pictures or ease curves they can reshape, and remember the project brief and their motion taste.
- **Render** through the render queue or `aerender` in the background, **read and answer popups**, and **save a diagnostics file** when something is stuck.

## Status

**v0.7.0, released 2026-11-07** (signed ZXP on the [v0.7.0 release](https://github.com/jameslashmar/chroma-ae-mcp/releases/tag/v0.7.0)). The panel updates itself from GitHub releases (see [Updates](#updates)).

- **180 tools**, all through the build, 5,598 unit tests and the ExtendScript lint; CI also runs the in-panel MCP end to end on AE's own Node (17.7.2).
- Live-tested on AE 26.2.1 and 26.3 on Windows; the 0.6.0 motion guidance and captions and the core of 0.7.0 (render in AE, busy handling, dialogs, batch import, layouts) were checked live on AE 26.3. macOS should work but is untested.
- Known issue: some background `aerender` jobs never start rendering; they now fail cleanly after 3 attempts.

Test details, what is open and what each release added: [docs/ROADMAP.md](docs/ROADMAP.md).

## Roadmap

Several items come from [premiere-pro-mcp](https://github.com/leancoderkavy/premiere-pro-mcp) (MIT), which solved the same problems for Premiere; details and reasons are in [docs/ROADMAP.md](docs/ROADMAP.md).

**0.8.0: reliability**
- [ ] Every write reports an outcome: `not_applied` when it was refused before touching the project, `unknown` when it failed part-way, with the safe next step (one Ctrl+Z, `ae_comp_diff`, the checkpoint).
- [ ] Idempotency keys, so a client that times out and resends doesn't make a second layer or precomp; `ae_recent_ops` lists recent writes and how each ended.
- [ ] Tool groups: `CHROMA_AE_MCP_TOOLSET=core,render,captions` and an explicit tool list, refusing unknown names at startup.
- [ ] A render started inside AE that can be stopped, and a guard against long H.264 renders in AE (both seen in the 0.7.0 live check).
- [ ] zod 4 (a high-severity zod 3 advisory), and the rest of the 0.7.0 live checklist.

**0.9.0: delivery checks**
- [ ] `ae_verify_render` compares sampled frames of the render with the comp (black or stale frames, lost alpha, gamma shifts, wrong output module).
- [ ] A broadcast-safe check: luma outside 16–235, chroma over EBU R103, and where in the frame.
- [ ] Codec and colour tags read from MP4/MOV files without ffprobe (ProRes 4444 vs 422, `colr` primaries and transfer).
- [ ] Exported MOGRTs opened and their controls checked against Essential Graphics.

**Later**
- [ ] A watcher for Cinema 4D and render output folders that offers `ae_version_footage` when a new version lands.
- [ ] `ae_can_execute`: check one call (schema, busy, render gate, guard) without running it.
- [ ] macOS: popup reading and a live run on a Mac (CI now builds and tests on macOS).

---

## Install (users)

1. **Install the ZXP.** Download `chroma-ae-mcp-<version>.zxp` from the latest release and install it with the [aescripts ZXP Installer](https://aescripts.com/learn/zxp-installer/) (or Anastasiy's). The certificate is self-signed ("Chroma AE MCP"), so expect a one-time warning.
2. **Start After Effects.** The MCP service starts by itself, invisibly, about 30 s after launch.
3. **Open Window > Extensions > Chroma AE MCP.** The panel should show **Connected** (pictured above).
4. **Set up your AI.** Under **Register with**, pick one: **Code** (Claude Code), **Desktop** (Claude Desktop), **Cursor** or **Codex**. **Copy** then puts that one's setup on the clipboard, and the line under the button says where it goes: a terminal command for Claude Code and Codex, or an entry to add inside `"mcpServers"` in the config file for Claude Desktop and Cursor. Pick the next one and copy again for each AI you use. Once an AI is set up, **Register with** twirls closed and lists what is set up; click it to open it again.
5. **Restart the client** (in Claude Code, `/mcp`). The `ae_*` tools appear.

**What you need:** Claude Code needs nothing but AE: the MCP runs on the Node built into AE's CEP. Claude Desktop, Cursor and Codex go through a small stdio relay, which needs Node 16 or later on the machine.

**The panel** shows this session's tool calls, queue, errors, median reply time and checkpoints, and a chart of the last 20 reply times. The **Log** at the bottom lists each tool call and checkpoint, and the service's own events (started, token loaded, warnings), newest first, with the raw service log inside it. Its twirl opens it below the tiles; the corner-arrows button makes it fill the panel, and clicking it again puts the tiles back. The panel remembers which you chose.

### Updates

<img src="docs/images/panel-update.png" width="240" align="right" alt="The panel with an update bar at the top: v0.4.2 is out, You have v0.4.1, with What's new and Update buttons">

The panel checks GitHub for a newer release when it opens, and again when you click **Check for updates** at the bottom of the panel. When there is one, a bar at the top says so:

- **What's new** opens the release notes in your browser.
- **Update** downloads the release's `.zxp` to your Downloads folder, checks it against the release's SHA256 (nothing is installed if it doesn't match), and opens it, so the ZXP installer registered for `.zxp` files (the aescripts ZXP Installer, or Anastasiy's) installs it.
- **Restart After Effects** when the installer finishes.

Coming from 0.4.0, which has no update button, install 0.4.1 by hand once.

<br clear="right">

**The token** belongs to this machine and survives restarts. **New token** in the panel replaces it, and Claude Code's user-scope `chroma-ae` entry is registered again automatically. The relay clients read the token themselves and need nothing.

### Registering by hand

**Claude Code.** **Copy setup command** in the panel gives this, to paste into a terminal:

```
claude mcp add --scope user --transport http chroma-ae http://127.0.0.1:7790/mcp --header "Authorization: Bearer <token>"
```

**Claude Desktop (Chat and Cowork), Cursor, Codex.** These can only launch a command, so they use the relay that ships with the panel. For Claude Desktop, open Settings > Developer > Edit Config, add this under `mcpServers`, then quit Claude Desktop from the tray and reopen it:

```json
"chroma-ae": {
  "command": "node",
  "args": ["<CEP extensions>/london.chroma.aemcp/tools/stdio-relay.cjs"],
  "env": { "CHROMA_AE_MCP_TOOLSET": "core" }
}
```

- `<CEP extensions>` is `%APPDATA%\Adobe\CEP\extensions` on Windows (escape backslashes as `\\` in JSON) and `~/Library/Application Support/Adobe/CEP/extensions` on macOS.
- The relay forwards to the same `/mcp` as Claude Code, so every client shares one write queue.
- **Toolsets.** All 180 tool schemas are about 795,000 characters (roughly 200,000 tokens). Claude Code loads tool schemas on demand, but whether Claude Desktop does the same is **unconfirmed**, so the Desktop entry above asks for the `core` toolset: 33 everyday tools plus `ae_search_tools`, `ae_get_tool_schema` and `ae_invoke_tool` (about 81,000 characters, with shortened descriptions that keep every parameter), and the other tools are reached through those three. In the panel, pick **Desktop** under **Register with** and press **Add to Claude Desktop (core toolset)**: it writes the entry above into `claude_desktop_config.json` (the file is backed up as `claude_desktop_config.json.chroma-bak` first, other servers and other settings are kept), then quit Claude Desktop from the tray and reopen it. If Desktop already has a `chroma-ae` entry without `CHROMA_AE_MCP_TOOLSET`, it keeps listing all tools until you press **Use the core toolset in Claude Desktop**. To go back to all 180 tools, delete the `CHROMA_AE_MCP_TOOLSET` line from the entry's `env` (or set it to `full`) and restart Desktop; the panel never puts the line back by itself, and never overwrites a value you set. Claude Code, Cursor and Codex are registered without it. The details are in [docs/TOOLS.md](docs/TOOLS.md).
- While AE is closed the relay answers `tools/list` from the last list the panel served (the core list has its own cache file, so it exists only after the panel has served it once with `CHROMA_AE_MCP_TOOLSET=core`; with no cache yet, `tools/list` returns an error), and calling a tool says to start AE.
- The panel's buttons back up each config file as `<file>.chroma-bak` before changing it.

---

## How it works

```
Claude Code ───────────HTTP /mcp (Bearer)──► london.chroma.aemcp.service   (hidden CEP extension, starts with AE)
Claude Desktop, Cursor,                       ├─ MCP endpoint (stateless JSON-RPC, no SDK: AE's Node 17 is too old for it)
Codex ──stdio──► tools/stdio-relay.cjs ───┘   ├─ single-writer queue · guard · quarantine · receipts · checkpoints
                                              ├─ questions for the user (ae_ask_user), served to the panel on /ask
                                              ├─ Node side: PNG and audio decode and analysis, aerender jobs, popups, asset watcher
                                              └─ evalScript ──► host/core.jsx + host/ext/*.jsx (ExtendScript)
                                            london.chroma.aemcp.panel   (Window > Extensions: status, log, register, questions, diagnostics)
```

**Why a thin guarded listener?** AE's ExtendScript DOM is complete, so `ae_run_jsx` can do almost anything. The typed tools exist where they add something `ae_run_jsx` cannot:
- verification (read-back, stale-frame checks, pixel checks);
- safety (guard, checkpoints, undo hygiene);
- a known AE trap, encoded once;
- large bounded reads;
- work ExtendScript can't do at all (pixel analysis, tracking, background renders).

## Safety

- **Every write names the project and comp it expects**, and is refused if AE has something else open.
- **One undo step per write**, with an automatic checkpoint copy of the `.aep` first and a read-back receipt after.
- **A write that times out is quarantined**: nothing more is written until someone checks and calls `ae_acknowledge`.
- **Popups are never suppressed**, AE is never killed mid-script, and the bridge only answers localhost with the token.

Full details, including what can't be undone: [docs/SAFETY.md](docs/SAFETY.md).

## Tools

180 tools in 55 groups (the last three, `ae_render_queue_render`, its status and `ae_layout_apply`, are not in the released 0.6.0), from reads and writes to planar tracking, captions (standards, QA, export and transcription), batch renders and delivery checks, plus Chroma's motion-director guidance and the `captions` guidance as MCP prompts and resources (`motion_director`, `motion_review`, `captions`). The full list: [docs/TOOLS.md](docs/TOOLS.md).

## Develop

Building, the dev install, releasing and QA are in [docs/DEVELOP.md](docs/DEVELOP.md). Read `CLAUDE.md` and `docs/BUILDERS.md` before writing code.

---

## Troubleshooting

- **Tools fail with `unreachable`:** is AE running and the service up? The panel shows Connected, and `curl -H "Authorization: Bearer <token>" http://127.0.0.1:7790/health` answers. The service starts about 30 s after AE launches.
- **401 errors:** the token was regenerated. Pick **Code** under Register with, click **Copy setup command** and paste it into a terminal again.
- **Something is stuck:** click **Save diagnostics** in the panel (or ask for `ae_diagnostics`) and read the file it names: it says which eval is in flight, for how long, and which popup is open.
- **A call is refused with 'After Effects is busy':** a popup, a script or a render holds AE. Call `ae_status` (answers within 10 s, names the popup), answer the popup under the dialog rules, don't retry in a loop. Nothing was sent and nothing is quarantined.
- **'Not reachable':** run `node panel/tools/relay-diagnose.cjs` (exit 0 fine, 2 wrong, `--json` available). Codes: `no_token`, `panel_not_installed`, `ae_not_running`, `only_unsupported_ae`, `debug_mode_off` (development install only), `service_down`, `port_other_program`, `token_rejected`, `other_ae_holds_port`, `service_busy`.
- **Two After Effects versions running:** the first to start keeps port 7790. The other panel shows 'Other AE has the connection (2025)' and `service.log` names the owner.
- **`CHROMA_AE_MCP_DIAGNOSE=off`** (old one-line relay text) or `quick` (no process probes).
- **Port 7790 is busy:** the service retries every 5 s and never starts a second server. Check that an old AE instance isn't still running.
- **Windows Firewall prompt when rendering:** `aerender` starts a background AE. Renders don't need network access, so cancelling the prompt is fine.
- **The ZXP installer can't parse the package:** `ExtensionManifest Version` must be the manifest *schema* version (7.0), not the CEP version (12.0).
- **Blank panel or JavaScript errors:** open `http://localhost:8097` (service) or `8096` (panel) in Chrome or Edge.

## Docs

- `docs/TOOLS.md`: every tool by group, the motion guidance, and where the MCP keeps its files.
- `docs/SAFETY.md`: the safety model in full.
- `docs/DEVELOP.md`: building, releasing and QA.
- `docs/ROADMAP.md`: test status, open items and what each release added.
- `SPEC.md`: the original design.
- `CLAUDE.md`: the ExtendScript and CEP rules every change must follow, and how to verify a change.
- `docs/BUILDERS.md`: how to add a tool group, with the AE 26 behaviour we have measured. Read it before writing code.
- `docs/FEATURES.md`: the full feature list, the gaps, and what to borrow.
- `docs/V02-PANEL-MCP.md`: how the MCP runs inside the panel.
- `docs/QA-HARNESS.md`: the QA harness plan.
- `docs/CI-RUNNER.md`: setting up the self-hosted runner with After Effects.
- `docs/HANDOVER.md`: notes from the 0.3.0 and 0.4 work, waves 1 to 5 included: what each package added, how it was checked, the AE behaviours relied on but not measured, what is impossible by script and what is used instead, and what was left open.

## Credits

Ideas and small pieces are borrowed (MIT) from [Engine-Room-Games/after-effects-mcp](https://github.com/Engine-Room-Games/after-effects-mcp) and [JUNKDOGE-JOE/after-effects-mcp](https://github.com/JUNKDOGE-JOE/after-effects-mcp). See `ATTRIBUTION.md`.

## License

Copyright (c) 2026 Chroma Studios. Licensed under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`); see `LICENSE`. If you distribute a modified version, or run one for others over a network, you must make its source available under the same licence. Code borrowed from other projects keeps its MIT licence; the notices are in `ATTRIBUTION.md`.
