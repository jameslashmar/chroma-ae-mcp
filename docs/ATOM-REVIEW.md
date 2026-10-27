# Atom (tryatom.ai) review

Reviewed 2026-10-27 from all 20 pages of https://tryatom.ai/docs. Drafted by an Antigravity worker (Gemini 3.8 Flash); Claude checked the claims against the downloaded text and corrected two overstatements: popup handling, and "diff cards". Treat everything here as Atom's own documentation, not tested behaviour.

**One line:** Atom is a commercial in-app AI chat panel for AE and Premiere, with an optional **MCP Mode**: a local `http://127.0.0.1:{port}/mcp` server for Claude Code, Codex or Cursor, with one-click registration. It is the closest product to chroma-ae-mcp. The main architectural difference is that Atom's panel must stay open, while our service starts with AE.

---

# Architectural and Feature Analysis: Atom (tryatom.ai) vs. chroma-ae-mcp

---

### 1. What Atom Is and How It Works Technically

**Atom** is a commercial autonomous AI extension for **Adobe After Effects** (CC 2022 v22.0+) and **Premiere Pro** (2025 v25.0+) (`getting-started_installation`). It packages as a CEP ZXP extension providing an in-app chat interface that inspects, plans, and executes project modifications directly (`introduction`).

* **In-App Panel & Architecture:** Atom runs as an interactive CEP panel inside Adobe host apps (`introduction`). It operates by evaluating ExtendScript (`evalScript`) against the host DOM (`reference_security`). Because ExtendScript executes within Adobe's scripting thread, Atom requires the host preference *"Allow Scripts to Write Files and Access Network"* (`reference_security`). It streams progress, renders collapsible tool-call inspection cards, supports conversational branching and in-place message editing, and fires audio completion notifications (`getting-started_first-automation`, `guides_best-practices`).
* **Supported Models & Reasoning:** Atom supports three provider backends: **Anthropic** (Claude Code), **OpenAI** (Codex), and **OpenCode** (local/custom provider CLI) (`getting-started_setup`, `reference_thinking-modes`). Users adjust reasoning effort dynamically via a slider (`Low`, `Medium`, `High`, `xHigh`, `Max`) and can toggle "Codex Fast Mode" (1.5× execution speed at 2.5× credit consumption) (`reference_thinking-modes`).
* **MCP Mode:** Under `Settings → MCP Mode`, Atom can shut down its internal chat interface and transform into a local Model Context Protocol (MCP) HTTP server (`reference_mcp-mode`).
  * *Transport & Bindings:* Binds exclusively to loopback (`http://127.0.0.1:{port}/mcp`) on an auto-discovered or user-pinned port (1024–65535) (`reference_mcp-mode`).
  * *Supported Clients:* Features one-click auto-registration toggles for **Claude Code**, **Codex CLI**, and **Cursor**, as well as a generic loopback URL toggle for any MCP client (`reference_mcp-mode`).
  * *Exposed Namespaces:* Exposes Adobe automation tools under `atom-ae` (After Effects) or `atom-premiere` (Premiere Pro), alongside `atom-chat` for shared session utilities (`reference_team-ai-setup`). The panel must remain open to bridge requests into ExtendScript (`reference_mcp-mode`).
* **Agent Setup:** Atom bundles internal runtimes for Claude Code and Codex, requiring no external CLI installation for standard browser OAuth flows (`getting-started_agent-setup`, `getting-started_setup`). For advanced environments, it can latch onto existing machine-level CLI installs (`codex login`) or OpenCode runtimes (`getting-started_setup`, `guides_troubleshooting`).
* **Integrations:** Atom offloads external media capabilities to optional third-party APIs via user-supplied keys stored encrypted in panel settings (`reference_integrations`):
  * *OpenRouter:* Generative imagery (Google Nano Banana 2/Pro, OpenAI GPT Image 2/Mini) (`reference_image-generation`).
  * *Pexels:* Stock footage and still image search and auto-import (`reference_integrations`).
  * *ElevenLabs:* Audio transcription generating word-level timestamps (`reference_integrations`).
* **Team & Enterprise AI Setup:** Supports managed configuration profiles (`requirements.toml`, `managed_config.toml`, MDM) (`reference_team-ai-setup`). Enforces server URL regex whitelisting (`^http://127[.]0[.]0[.]1:[0-9]+/mcp$`) and granular tool approval (`default_tools_approval_mode = "approve"`) (`reference_team-ai-setup`). Connects directly to enterprise Claude or ChatGPT workspaces with zero AI proxying or token markups (`reference_team-ai-setup`).

---

### 2. Feature Inventory Table

Comparison between Atom and our tool (`chroma-ae-mcp` v0.2.0):

| Feature | What Atom Does (Concrete, Citing Page) | Do We Have It? (Yes / Partial / No) |
|---|---|---|
| **MCP Server Transport** | Exposes local HTTP endpoint (`http://127.0.0.1:{port}/mcp`) on toggle (`reference_mcp-mode`). | **Yes** — Native background CEP service at `127.0.0.1:7790/mcp` with Bearer auth (`our-readme.md`). |
| **In-App Chat Panel** | Full chat timeline, branching, tool inspection cards, auto-scroll, audio chimes (`introduction`, `guides_best-practices`). | **No** — Intentionally headless MCP driven by terminal Claude Code; panel only shows status/logs (`our-readme.md`). |
| **Project & Layer Inspection** | Bounded inspection of comp hierarchies, layer trees, and properties (`getting-started_first-automation`, `reference_skills`). | **Yes** — `ae_get_project`, `ae_get_comp`, `ae_get_layer_props`, `ae_get_layer_full`, `ae_find_layers` (`our-readme.md`). |
| **Property & Ease Animation** | Sets properties, expressions, and keyframe ease (`guides_common-workflows`). | **Yes** — `ae_set_property`, `ae_set_keyframe_ease`, `ae_set_text` (`our-readme.md`). |
| **Comp Diffing & Fingerprinting** | Not documented. The tool-call cards "show exactly what Atom found" (`guides_best-practices`); there is no before/after diff. | **Yes** — `ae_comp_fingerprint`, `ae_comp_diff` evaluated in independent scripts (`our-readme.md`). |
| **Project Checkpoints & Revert** | Auto-saves pre/post `.aep` / `.prproj` snapshots; reverts via chat clicks (`reference_checkpoints`). | **Yes** — `ae_checkpoint_create`, `ae_checkpoint_list`, `ae_checkpoint_revert`, `ae_save` (`our-readme.md`). |
| **Expression Validation** | Outlines dependencies and evaluates expression errors (`guides_best-practices`, `reference_skills`). | **Yes** — `ae_validate_expressions` (`our-readme.md`). |
| **Visual Frame Capture** | Sends composition/sequence preview frames to AI context (`reference_attachments`, `reference_security`). | **Yes** — `ae_snapshot_frame`, `ae_compare_frames` (pixel diffing) (`our-readme.md`). |
| **Modal Dialog Handling** | Not covered anywhere in the docs. | **Yes** — `ae_dialogs`, `ae_dialog_respond` via out-of-process Windows UI Automation (`our-readme.md`). |
| **Render Automation** | Automates background exports via templates and presets (`guides_common-workflows`). | **Yes** — `ae_render_queue_add`, `ae_aerender_start`, `ae_aerender_status`, `ae_aerender_cancel` (`our-readme.md`). |
| **Reentrancy Quarantine** | No execution quarantine; advises manual undo and re-prompting on timeout (`guides_troubleshooting`). | **Yes** — `ae_quarantine_status`, `ae_acknowledge` guard against zombie state (`our-readme.md`). |
| **Skills System** | Global and project-scoped `SKILL.md` recipes with bundled `.jsx` files (`reference_skills`). | **No** — Claude Code has native skills, but our MCP lacks project-scoped AE skill bundling. |
| **Multimodal Attachments** | Drag-and-drop ingest of images (max 1568px), PDFs, Office docs, CSVs, audio (`reference_attachments`). | **No** — Claude Code handles file ingest; our MCP does not ingest or resize arbitrary media for AE. |
| **GenAI Image Creation** | Generates textures/sprites via OpenRouter into local image cache and auto-imports (`reference_image-generation`). | **Partial** — We have `ae_import_footage`, but no genAI generation/caching pipeline (`our-readme.md`). |
| **Stock Media Search** | Searches and auto-imports stock media via Pexels API (`reference_integrations`). | **No** — Not implemented. |
| **Audio Speech Transcription** | Word-level speech-to-text via ElevenLabs to place markers (`reference_integrations`, `guides_common-workflows`). | **No** — Planned for VoxMark engine reuse (`our-features.md`), but not in current tools. |
| **Premiere Pro Support** | Bins, selects cuts, ripple silence removal, captioning, reframing (`guides_common-workflows`, `reference_attachments`). | **No** — `chroma-ae-mcp` is AE-focused (`our-readme.md`). Studio handles Premiere in separate MCP. |
| **Configurable Security Modes** | Toggles: Adobe Only, Project Folder, Full Access, Provider Settings (`reference_security`). | **Partial** — Enforces token auth, strict target guards, and localhost binding, but no shell toggles (`our-readme.md`). |

---

### 3. Ideas Worth Scoping for Our Tool (Ranked by Value)

*(Cross-referenced with `our-features.md` to highlight novel concepts and areas strengthening planned items).*

#### 1. Project-Scoped & Global Motion Skills with JSX Attachments (`reference_skills`)
* **What it is:** A formal convention and toolset for authoring and executing skills stored as `SKILL.md` (YAML frontmatter + markdown) paired with numbered helper scripts (`1.jsx`, `2.jsx`) in `[Project Folder]/atom/skills/` (project-scoped) or user config (global).
* **Why valuable:** Motion designers repeatedly build identical kinetic type rigs, branded lower thirds, and overshoot curves. Claude Code can natively author and consume these files.
* **Studio Gap Analysis Alignment:** Strongly reinforces the planned **P3 Saved-Snippet Library** (JUNKDOGE `ae_toolSave`) and **P3 House Style / Brand Checks**. As predicted in `our-features.md`, *"A Claude skill holding recipes may do the job more simply"*—Atom proves that attaching numbered JSX scripts directly to markdown skills is the exact architectural pattern to adopt.
* **Effort:** **M** (Define skill file schema, add an `ae_skill_export` tool to extract comp state into a skill folder).

#### 2. Auto-Import Asset Cache Directory Pattern (`reference_image-generation`, `reference_attachments`)
* **What it is:** Standardizing a dedicated project subfolder (`[Project]/_work/assets/cache/` adhering to Jay's rule) where external image generation or processing tools output media, wired to an automatic import into an `_Assets` project bin.
* **Why valuable:** When Claude Code creates textures, matte passes, or UI sprites via CLI or scripts, artists currently must locate and import them manually. A predictable asset-staging pattern makes imported footage immediately referenceable in timeline scripts.
* **Studio Gap Analysis Alignment:** Directly strengthens the planned **P1 Footage Import/Replace** (shipped) and **P2 Shot Versioning** by establishing a deterministic staging directory.
* **Effort:** **S** (Pure filesystem convention + lightweight helper function in `ae_import_footage`).

#### 3. Data & Brief Context Ingestion for Procedural Motion (`reference_attachments`, `guides_effective-prompts`)
* **What it is:** Standard operating prompts and validation schemas for feeding CSV/Excel tables, PDF brand books, and design specs directly into Claude Code to procedurally generate comp layouts and chart animations.
* **Why valuable:** Unlocks rapid infographic and localized marketing variation directly from raw spreadsheet data.
* **Studio Gap Analysis Alignment:** Significantly strengthens the planned **P2 Template Population** (*"fill text and footage placeholders from CSV or JSON"*). Atom's documented prompt workflows provide clear patterns for translating tabular rows into keyframed shape layer heights and text arrays.
* **Effort:** **S** (Documentation, prompting recipes, and a reference Claude skill).

#### 4. Automated Multi-Aspect Ratio Social Re-framing (`guides_common-workflows`, `reference_skills`)
* **What it is:** A scripted workflow that duplicates an approved composition into 16:9, 1:1, and 9:16 targets, adjusts bounding dimensions, re-anchors master controllers, and applies safe-area padding.
* **Why valuable:** Social versioning is tedious production overhead. Automating layout transforms across common social aspect ratios saves hours of studio time.
* **Studio Gap Analysis Alignment:** Not present in `our-features.md`. Expands our workflow tooling beyond single comps.
* **Effort:** **M** (ExtendScript layout math and layer bounding-box recalculations).

#### 5. Silence Gap Removal & Cue Marker Placement (`guides_common-workflows`, `reference_skills`)
* **What it is:** Scanning speech or audio tracks to identify pauses exceeding a duration threshold, creating comp markers at speech boundaries, or ripple-editing gaps.
* **Why valuable:** Eliminates rough-cut friction when syncing voiceovers to kinetic typography.
* **Studio Gap Analysis Alignment:** Directly validates and strengthens planned **P2 VO to Markers (VoxMark engine reuse)** and **P2 Audio Waveform Analysis**.
* **Effort:** **M** (Adapt existing internal VoxMark logic into a typed MCP tool).

#### 6. Diagnostic Feedback Bundling (`guides_troubleshooting`)
* **What it is:** A utility that collates recent JSON-RPC logs, quarantine state, AE version data, and open modal dialog status into a clean diagnostic markdown file.
* **Why valuable:** Greatly accelerates triage between motion designers and tooling developers when automation blocks.
* **Studio Gap Analysis Alignment:** Strengthens our status panel and bridge observability.
* **Effort:** **S** (Expose internal service circular buffer via panel button / CLI tool).

---

### 4. Things Atom Does That We Deliberately Should NOT Copy

1. **In-App CEP Chat Interface:** Atom embeds an entire chat timeline and AI client into CEP (`introduction`, `getting-started_first-automation`). *Why reject:* CEP's Node runtime (v17.7.2) is legacy and fragile. Embedding chat UI bloats the extension, complicates auth, and duplicates Claude Code's terminal interface. Our headless MCP architecture (`our-readme.md`) keeps AE clean and lightweight.
2. **"Adobe Only" False Sandboxing:** Atom markets "Adobe Only" as a security boundary while admitting ExtendScript can freely execute arbitrary filesystem and network commands (`reference_security`). *Why reject:* Security by obscurity violates our principles. We rely on cryptographic Bearer tokens, localhost-only binding, strict Host/Origin rejection, and explicit target guards (`project_path` / `comp_id`) (`our-readme.md`).
3. **Third-Party API Key Hoarding in Panel UI:** Atom stores raw API keys for OpenRouter, Pexels, and ElevenLabs inside CEP localStorage/settings (`reference_integrations`). *Why reject:* Violates our 1Password and Windows User environment variable policy (`[Environment]::GetEnvironmentVariable`). Secrets must never be pasted into Adobe panels.
4. **Popup handling is undocumented:** Atom's docs never mention modal dialogs. *Why reject:* Violates Jay's rule (*"Popups are never suppressed"*). Our Windows UI Automation daemon (`ae_dialogs`, `ae_dialog_respond`) safely reads and logs popups without wedging AE (`our-readme.md`).
5. **Silent Re-prompting Over Quarantine:** When an automation hangs, Atom tells the user to manually undo and rephrase (`guides_troubleshooting`). *Why reject:* Unknown script outcomes risk project corruption. Our strict quarantine state (`ae_quarantine_status`, `ae_acknowledge`) halts writes until a human verifies the timeline (`our-readme.md`).
6. **Destructive Reverts Without Target Guarding:** Atom allows users to disable revert confirmation prompts entirely (`reference_checkpoints`). *Why reject:* Destructive reverts must always require explicit verification against project path and checkpoint IDs to prevent accidental loss of live work.

---

### 5. Pricing and Limits Summary

*(Verified facts from `reference_pricing` and `reference_usage-limits`):*

* **Trial:** 7-day free trial, fully functional locally on the machine; requires no account to initiate (`reference_pricing`).
* **Licence Model:** One-time purchase covering perpetual ownership of the acquired version. Includes 1 full year of software updates. After 1 year, the installed build works indefinitely without recurring subscription fees; an optional upgrade fee renews update eligibility for another year (`reference_pricing`).
* **Seats & Hardware Limits:** Each standard licence covers 1 person on up to 2 computers. Users can remotely revoke and reassign active hardware seats via `Settings → Account → Computers` (`reference_pricing`).
* **Team Licences:** Offered in two structures:
  1. *Team License Key:* Shared alphanumeric key (`XXXX-XXXX-XXXX-XXXX`) activated directly with a pooled seat quota (`reference_pricing`).
  2. *Email Teams:* Centralized portal managed by the purchasing admin under `Settings → Account → Team`. Teammates receive six-digit email verification codes (each assigned 2 machines); revoking an email reclaims the seat within 24 hours (`reference_pricing`).
* **AI Provider Billing:** Atom adds **no markup, proxy fees, or token margins** on AI traffic (`reference_pricing`, `reference_usage-limits`). Users connect directly to their own provider plans:
  * Anthropic: Claude Code personal, Team, or Enterprise subscription, or direct API billing (`reference_usage-limits`).
  * OpenAI / Codex: ChatGPT personal, Business, Enterprise, or developer API keys (`reference_usage-limits`).
  * OpenCode: Billed directly by whichever third-party provider is configured in the local OpenCode environment (`reference_usage-limits`).
* **Codex Fast Mode Rate:** 1.5× execution speed consuming credits at **2.5× the standard consumption rate** (`reference_thinking-modes`).
* **Usage Limits:** Atom imposes **zero message limits** (`reference_usage-limits`). All rate caps, context window limits, and token throttling derive strictly from the user's underlying AI provider (`reference_usage-limits`).
* **Media Integrations:** OpenRouter, Pexels, and ElevenLabs are billed entirely separately via user-supplied API accounts (`reference_pricing`, `reference_integrations`).

