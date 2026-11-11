# CLAUDE.md: chroma-ae-mcp

An MCP server that runs inside After Effects as a CEP panel, so agents can drive AE alongside a
person editing live. `server/` is the TypeScript MCP server (vitest), `panel/host/` is the
ExtendScript side (`core.jsx` holds the `__chromaAe` helpers), `SPEC.md` is the design.

Git, file locations, secrets and vault capture follow the global rules; nothing here differs.

## ExtendScript and CEP constraints

These apply to anything in `panel/host/`, JSX templates, and JSX strings sent to After Effects.
Each one fails silently or wedges AE, so none of them shows up as an error at the point of the
mistake.

- **ExtendScript is ECMAScript 3.** No `let`, `const`, arrow functions, template strings or
  `class`; use `var` and `function`. No `forEach` / `map` / `filter` / `reduce` unless `core.jsx`
  polyfills it. There is no native `JSON`; use `__chromaAe.jsonStringify`.
- **No chained ternaries, parenthesised or not.** ExtendScript parses them left-associatively:
  `a ? b : c ? d : e` runs as `(a ? b : c) ? d : e`, so the logic is silently wrong. Write
  `if / else`. `scripts/lint-jsx.mjs` fails on any chained ternary.
- **Never abort an in-flight `evalScript`.** Killing one wedges the ExtendScript bridge and AE
  ignores every later call until it is restarted. The queue waits until AE responds or the
  sentinel drains.
- **An undo group opens and closes in the same `evalScript` call.** A group begun in one call and
  ended in another is discarded by AE. Every mutation goes through `withUndo` in `core.jsx`.
- **Read back in a separate `evalScript` call.** A read in the same script as the write returns
  stale cached values, so verification runs as its own call after the write completes.
- **`saveFrameToPng` can report success and hand back a cached frame** from an earlier render.
  Check the PNG's mtime is newer than the request and its size is above zero; if stale, retry once
  with a small time nudge.
- **`app.executeCommand` does nothing through CEP**, because CEP has no host menu focus. Use DOM
  methods instead (`comp.duplicate()`, `layer.duplicate()`).

## Before calling a slice done

1. In `server/`: `npm run build`, then `npm test` (vitest, all green).
2. From the repo root: `node scripts/lint-jsx.mjs` reports 0 issues across `panel/host/**/*.jsx`.
