# CLAUDE.md

Rules and architecture guide for agents working on `chroma-ae-mcp`.

---

## 1. Core ExtendScript & CEP Constraints (Non-Negotiable)

When writing or modifying code in `panel/host/`, JSX templates, or JSX strings sent to After Effects:

- **Strict ECMAScript 3 (ES3)**:
  - After Effects runs ExtendScript, which is ECMAScript 3.
  - **Forbidden**: `let`, `const`, `=>` (arrow functions), backtick template strings (`` ` ``), `class`.
  - **Forbidden**: Modern JS array methods (`forEach`, `map`, `filter`, `reduce`) unless explicitly polyfilled in `core.jsx`.
  - **Forbidden**: Native `JSON` (ExtendScript has none; use `__chromaAe.jsonStringify` from `core.jsx`).
  - Always use `var` and traditional `function` declarations.
- **No Chained Ternaries**:
  - ExtendScript parses chained ternaries **left-associatively**: `a ? b : c ? d : e` evaluates as `((a ? b : c) ? d : e)`. The first truthy condition becomes the next test, silently corrupting logic.
  - Never use chained ternaries. Always use explicit `if / else` statements.
  - Parentheses do not excuse ternaries—any chained ternary fails `scripts/lint-jsx.mjs`.
- **Never Abort an In-Flight `evalScript`**:
  - Killing or aborting an in-flight `evalScript` wedges the ExtendScript bridge, rendering After Effects unresponsive to future calls until restarted.
  - The queue must wait and block until After Effects responds or the sentinel drains.
- **Undo Group `begin` and `end` in the Same Call**:
  - Opening an undo group (`app.beginUndoGroup`) in one `evalScript` and closing it in another causes After Effects to **discard** the group entirely.
  - Every mutation must open and close its undo group in the exact same call (funnelled through `withUndo` in `core.jsx`).
- **Read-Back in a Separate `evalScript` Call**:
  - ExtendScript reads in the same script as a mutation return stale cached values from internal buffers.
  - Mutation verification read-backs must always be executed in a separate, subsequent `evalScript` call after the write completes.
- **`saveFrameToPng` Stale Buffer Guard**:
  - `saveFrameToPng` can report success while returning a cached frame from an earlier render.
  - Always verify that the rendered PNG file mtime is newer than the request time and file size > 0. If stale, retry once with a micro-time nudge.
- **`app.executeCommand` Silently No-Ops**:
  - `app.executeCommand` does nothing through CEP because CEP lacks host menu focus. Always use native ExtendScript DOM methods (e.g. `comp.duplicate()`, `layer.duplicate()`).

---

## 2. Testing & Verification Guard

Before claiming any task or slice is done:

1. **Server Build & Unit Tests**:
   - `cd server`
   - `npm run build`
   - `npm test` (vitest suite must pass green)
2. **JSX Linter**:
   - Run from repo root: `node scripts/lint-jsx.mjs`
   - Must scan all `panel/host/**/*.jsx` and report 0 issues (no chained ternaries, no ES5+ syntax).

---

## 3. Git, Branching & Commit Policy

- **Trunk-Based**: `main` must always remain releasable. Tests and linter must be green before every push.
- **Never Commit or Push Unless Jay Asks**: Regardless of how green tests and builds are, do not run `git commit` or `git push` without Jay's explicit direction.
- **Branches**: Default to working on `main`. Branch only for spikes, PR review, or hotfixes from release tags.

---

## 4. File Creation & Environment Policy

- **Allowed File Locations**:
  1. The repo itself (`H:\Github_repos\chroma-ae-mcp\`).
  2. The session scratchpad (temporary files).
  3. The project's Dropbox folder in `_work/` for persistent artifacts outside git (demo scenes, captures).
  - **Never** create files in `C:\Users\Public`, `%TEMP%` outside scratchpad, home dot-directories, or other project roots.
- **1Password & Secrets**:
  - Read secrets from Windows User environment variables (`[Environment]::GetEnvironmentVariable('<NAME>', 'User')`), e.g. `OBSIDIAN_API_KEY`.
  - Never run `ssh-add` or `ssh -T` on Windows (wedges 1Password OpenSSH pipe).

---

## 5. Capture Outcomes to Obsidian Vault

At the end of any substantive session (decisions made, bugs fixed, features built), capture outcomes to Jay's Obsidian vault via the **NAS Local REST API**:
- **Endpoint**: `https://10.198.6.5:27124` (`curl.exe -k`)
- **Key**: Read `OBSIDIAN_API_KEY` from User environment variables.
- **Rule**: NEVER write directly to disk at `H:/Obsidian` (it is a LiveSync replica; writing to disk causes stale duplicate drift). Always use the REST API.
- Update relevant project notes and create atomic notes for durable facts.
