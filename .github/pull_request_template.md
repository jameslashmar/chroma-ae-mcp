## What this changes

<!-- What and why, briefly. -->

## Live evidence

<!-- Required when the PR changes After Effects code (panel/host, panel/tools, panel/CSXS,
     server/src, panel/client scripts): run `node qa/live-evidence.mjs` on the latest commit
     and commit the qa/evidence/<commit>.json it writes. See docs/LIVE-EVIDENCE.md. -->

- [ ] `qa/evidence/<commit>.json` committed (or: no After Effects code changed)
- AE version and OS:
- Smoke result (passed / total), and anything failed or skipped:
- Manual checks (what a person looked at):

## Checks

- [ ] `npm run build` and `npm test` in `server/`
- [ ] `node scripts/lint-jsx.mjs`
- [ ] Panel bundle rebuilt (`npm run bundle`) if `server/src` changed
