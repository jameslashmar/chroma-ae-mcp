import { beforeEach } from "vitest";
import { resetHungFsCalls } from "../src/seqscan.js";
import { resourceDeps } from "../src/system-resources.js";
import { pngWaitDeps } from "../src/tools/render.js";

// No test starts PowerShell: every test file gets a probe that finds nothing. A test that wants a reading sets resourceDeps.run itself.
resourceDeps.run = async () => null;

// A test that leaves fs calls "stuck" (a share that never answers) must not close the gate for the next test.
beforeEach(() => resetHungFsCalls());

// Tests must not write a usage log into the real data dir. The usage-log tests turn it on for a temp dir.
process.env.CHROMA_AE_MCP_USAGE_LOG = "off";

// saveFrameToPng writes late in AE, so production polls the PNG every 100 ms; a test writes it at once. A frame that never appears ends at 1 s, not 10 s.
pngWaitDeps.intervalMs = 1;
pngWaitDeps.timeoutMs = 1_000;
