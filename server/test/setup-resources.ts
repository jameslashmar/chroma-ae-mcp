import { beforeEach } from "vitest";
import { resetHungFsCalls } from "../src/seqscan.js";
import { resourceDeps } from "../src/system-resources.js";

// No test starts PowerShell: every test file gets a probe that finds nothing. A test that wants a reading sets resourceDeps.run itself.
resourceDeps.run = async () => null;

// A test that leaves fs calls "stuck" (a share that never answers) must not close the gate for the next test.
beforeEach(() => resetHungFsCalls());
