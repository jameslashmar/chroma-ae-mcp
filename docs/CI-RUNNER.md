# Self-hosted runner with After Effects

GitHub's hosted runners have no After Effects, so the live checks (`qa/smoke-mcp.mjs`, and later the VoxMark and Gulp scenarios) need a machine of our own. The workflow is ready: `.github/workflows/ae-live.yml` runs `qa/ci-live.mjs` on a runner labelled `after-effects`. It is manual (`workflow_dispatch`) until a runner is registered.

## The machine
- Windows with After Effects 2026 installed and licensed for the runner's user. A QA box, never someone's working session: the smoke test closes and creates projects (only QA ones; it refuses otherwise).
- Node 22 (the job sets it up), Git, PowerShell 7.
- PlayerDebugMode on, with the panel installed from the runner's checkout:
  1. let the workflow check out once (or clone to the runner's work folder);
  2. run `scripts/install-dev.ps1` from that checkout;
  3. start AE and confirm Window > Extensions > Chroma AE MCP shows Connected.

  `qa/ci-live.mjs` refuses to run if the extension points anywhere else, because the test must load this checkout's code.

## The runner
1. In the repo: Settings > Actions > Runners > New self-hosted runner (Windows). Follow GitHub's download and `config.cmd` steps, and add the label `after-effects`.
2. **Run it in the logged-on user's session (`run.cmd`), not as a Windows service.** A service runs in session 0, where After Effects can't open its UI or CEP panels. Use auto-logon and a logon task that starts `run.cmd`, so it comes back after a reboot.
3. Keep After Effects open, or give the job the path to start it: set `AE_EXE` for the runner (for example `C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe`). `qa/ci-live.mjs` waits up to 5 minutes for the panel service.

## What a run does
1. `npm ci`, build, unit tests, bundle, and the ES3 lint, as in CI.
2. `qa/ci-live.mjs`:
   - waits for `/health`;
   - reloads the panel service through its debug port (8097), so the new bundle and `host/ext/*.jsx` load without restarting AE;
   - runs the smoke test in a fresh `_work/qa/ci/<stamp>` folder.
3. `qa/out/` is kept as the `ae-live-report` artifact.

Popups are never suppressed. A dialog that blocks a run shows up as a stuck step. `ae_diagnostics` (or the panel's Save diagnostics button) on the runner says which eval is in flight and which popup is open.

## Turning it on for every push
After a few green manual runs, add this to the workflow's `on:` block:

```yaml
  push:
    branches: [main]
```

Leave pull requests off unless the repo is private: a self-hosted runner would run code from forks.
