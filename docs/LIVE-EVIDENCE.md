# Live evidence for pull requests

No CI machine runs After Effects, so unit tests against a fake AE are all CI can do by itself. A pull request that changes After Effects code therefore has to bring **evidence that it ran in a real After Effects**: a report written by `qa/live-evidence.mjs`. The **Live evidence** check refuses the PR without one, and `main` only accepts PRs whose checks pass.

## What counts as After Effects code

Anything under `panel/host/`, `panel/tools/`, `panel/CSXS/`, `server/src/`, and the panel's scripts and HTML (`panel/client/*.js`, `*.cjs`, `*.html`). Docs, tests, CI files, the QA harness and the panel's CSS need no evidence.

## Making the report

On a machine with After Effects 2026:

1. Install this checkout's panel once with PlayerDebugMode on (`pwsh -File scripts/install-dev.ps1` on Windows; see `docs/CI-RUNNER.md`), then restart AE. Use Node 22 or later. The run checks that the CEP extension points at this checkout and reloads the panel service, so the code that runs is the code in the branch.
2. Open an empty, unsaved project in AE (the smoke test refuses to touch anything else).
3. Commit your changes. The report names the commit that ran, so the script refuses to start with uncommitted changes.
4. Run:

   ```bash
   node qa/live-evidence.mjs                       # the full live smoke test, several minutes
   node qa/live-evidence.mjs --notes notes.json    # with manual checks and failure explanations
   ```

5. Commit the file it writes, `qa/evidence/<commit>.json`, on top of the tested commit and push.

After the tested commit, only evidence files and Markdown may change. Any later code change needs a new run on the new commit.

## Notes: manual checks and failures

The smoke test covers every tool, but not everything a change does: a popup, a Media Encoder hand-off or a visual result needs a person to look. Put those in a notes file:

```json
{
  "manual": [
    { "tool": "ae_render_queue_render", "check": "engine media_encoder queues the item in AME with the output path unchanged", "result": "pass", "notes": "AME 26.3, preset H.264 Match Source" }
  ],
  "explainedFailures": {
    "ae_aerender_start": "aerender never starts on this machine, also on main (docs/HANDOVER.md)"
  }
}
```

- `result` is `pass`, `fail` or `n/a`. A failed manual check needs notes.
- Every failed smoke check needs an entry in `explainedFailures` (10 characters or more) saying why it isn't the PR's fault. The reviewer reads these.
- **A new tool** must appear in the report: either a step in `qa/smoke-mcp.mjs` (preferred) or a manual check whose `tool` names it.

## What the check refuses

- AE code changed and no `qa/evidence/*.json` in the PR.
- A report whose commit isn't in the PR's history, or with code changed after it.
- A smoke run that stopped early, ran no checks, had host files fail to load, or has unexplained failures.
- A new tool that nothing checked.

It is honour-based: a report can be written by hand. It exists so that "not run in After Effects" can't slip through by accident, and so the reviewer sees what was run, on which AE, and what failed.

## For the maintainer

`main` requires a PR with an approving review and these checks: the Windows test runs, the CEP Node check, the dependency audit and Live evidence. Admins can still push directly (trunk-based releases), and can merge past a failing check when a change genuinely can't be run live, saying why in the PR.
