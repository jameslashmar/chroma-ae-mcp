import { beforeEach } from "vitest";
import { resetHungFsCalls } from "../src/seqscan.js";
import { resourceDeps } from "../src/system-resources.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetCepAutostartCache } from "../src/tools/ext/aerender.js";
import { forgetCatalogs, renderFormatsDeps } from "../src/tools/ext/render-formats.js";
import { frameCaptureDeps, pngWaitDeps, resetUnwrittenFrame } from "../src/tools/render.js";

// No test starts PowerShell: every test file gets a probe that finds nothing. A test that wants a reading sets resourceDeps.run itself.
resourceDeps.run = async () => null;

// A test that leaves fs calls "stuck" (a share that never answers) must not close the gate for the next test.
beforeEach(() => resetHungFsCalls());

// Tests must not write a usage log into the real data dir. The usage-log tests turn it on for a temp dir.
process.env.CHROMA_AE_MCP_USAGE_LOG = "off";

// saveFrameToPng writes late in AE, so production polls the PNG every 100 ms; a test writes it at once. A frame that never appears ends at 1 s, not 10 s.
pngWaitDeps.intervalMs = 1;
pngWaitDeps.timeoutMs = 1_000;
// A frame grab waits for a render still in progress, a missing file included (no fake AE writes one for a refused or
// stale grab), before retrying and again after a final failure; production gives AE 20 s each. Tests: 1 s.
frameCaptureDeps.lateWriteMs = 1_000;
frameCaptureDeps.settleAfterFailMs = 1_000;

// No test reads this machine's CEP extension folders: aerender tools would refuse on a PC with many auto-start extensions. A test that wants a list sets it itself.
beforeEach(() => resetCepAutostartCache([]));

// No test reads or writes this machine's measured render formats (render-formats.json in the real data dir).
renderFormatsDeps.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-formats-test-"));
beforeEach(() => forgetCatalogs());

// A frame one test left unwritten must not hold the frame renders of the next (production holds them 2 minutes).
beforeEach(() => resetUnwrittenFrame());
