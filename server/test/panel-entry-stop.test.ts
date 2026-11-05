import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPanelMcp } from "../src/panel-entry.js";

describe("createPanelMcp stop()", () => {
  it("stops the asset watcher's polling timer, so a service that shuts down does not keep polling evalScript", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-panel-stop-"));
    try {
      const mcp = createPanelMcp({ dataDir, sessionTracking: false, evalScript: async () => ({ ok: true, result: {}, durationMs: 1 }) });
      const stop = vi.spyOn(mcp.assetWatcher, "stop");
      expect(typeof mcp.stop).toBe("function");
      mcp.stop();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
