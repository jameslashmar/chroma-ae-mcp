# Develop (Chroma)

```powershell
cd server; npm install; npm run build; npm test; npm run bundle   # bundle -> panel/client/mcp-bundle.cjs
node scripts/lint-jsx.mjs                                         # ES3, no chained ternaries, ASCII only in panel/host
pwsh scripts/install-dev.ps1                                      # junction panel/ into CEP extensions, PlayerDebugMode=1
node qa/smoke-mcp.mjs --dir <a fresh /_work/qa/ folder>           # live: most tools against the running AE (see qa/README.md for what is covered)
```

- Read `CLAUDE.md` and `docs/BUILDERS.md` before writing code: they hold the ExtendScript rules and the AE 26 traps we have measured.
- Restart AE after any manifest change. For code changes, reload the service page at `http://localhost:8097` (the panel is on `8096`); no AE restart is needed. After a `core.jsx` change, clear `$.global.__chromaAe` first.
- Commit the output of `npm run bundle`: CI checks that the bundle is up to date.
- Host code can be tested without AE: `server/test/support/fake-ae.ts` is a small simulated AE DOM, and `host-jsx*.test.ts` run `panel/host/*.jsx` against it under `node:vm`. It follows AE where the host code depends on it, but only a live run in AE proves the code.
- **Never install the ZXP on a machine that has the dev junction.** An installer could delete through it into the repo. Run `install-dev.ps1 -Uninstall` first.

## Releasing

1. Bump `VERSION`, and to the same number `version` in `server/package.json` and `server/package-lock.json` and `SERVER_VERSION` in `server/src/mcp-rpc.ts` (`test/version.test.ts` fails until they match).
2. Put `ZXPSignCmd.exe` in `build/` (gitignored). Copies live in `AFX-VoxMark/build/` and `AFX_Gulp/builds/signing/win/`.
3. Run `op-sa op run --env-file scripts/release.env -- pwsh -NoProfile -File scripts/package.ps1`. It stages the panel, stamps the version, signs, verifies and prints the SHA256. The certificate passphrase is in 1Password: Release Signing / "Chroma AE MCP ZXP cert".
4. Tag `vX.Y.Z` on the build commit, then create the GitHub release with the `.zxp` and its SHA256.

## QA

- **Live smoke test** (`qa/smoke-mcp.mjs`): most tools against a running AE in a throwaway project (the 24 wave 4 and 5 tools have no steps yet; see `qa/README.md`). It refuses to start unless AE has an empty, QA-owned or `/_work/qa` project open.
- **Product scenarios** (`qa/runner.js`): runs a product's real ExtendScript (**VoxMark**, **Gulp**) in a real AE against throwaway projects, loading it the way the product does, and asserts AE state in separate calls.
  ```
  node qa/runner.js qa/scenarios/voxmark      # report: qa/out/report.md + junit.xml
  ```
- **Self-hosted runner** (`qa/ci-live.mjs`, `.github/workflows/ae-live.yml`): runs the smoke test on a machine with AE. Ready, but no runner is registered yet (`docs/CI-RUNNER.md`).

Details in `qa/README.md` and `docs/QA-HARNESS.md`.
