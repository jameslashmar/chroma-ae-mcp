import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QuarantineBlockedError,
  QuarantineStore,
} from "../src/quarantine.js";

describe("QuarantineStore", () => {
  const tmpDirs: string[] = [];

  function makeTempStore(): { store: QuarantineStore; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-ae-qtest-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "quarantine.json");
    return { store: new QuarantineStore(file), file };
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("blocks mutating operations when an op is quarantined and clears after acknowledge", () => {
    const { store } = makeTempStore();
    expect(store.isQuarantined).toBe(false);
    expect(() => store.assertClear()).not.toThrow();

    store.add({
      op_id: "op_123",
      tool: "ae_set_property",
      label: "Set opacity",
    });

    expect(store.isQuarantined).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(() => store.assertClear()).toThrow(QuarantineBlockedError);

    try {
      store.assertClear();
    } catch (err) {
      const qErr = err as QuarantineBlockedError;
      expect(qErr.kind).toBe("quarantined");
      expect(qErr.message).toContain("op_123");
      expect(qErr.message).toContain("ae_status");
      expect(qErr.message).toContain("ae_acknowledge");
    }

    const ack = store.acknowledge("op_123", "Verified opacity in AE is 50%");
    expect(ack.acknowledged).toBe(true);
    expect(ack.remaining).toHaveLength(0);
    expect(store.isQuarantined).toBe(false);
    expect(() => store.assertClear()).not.toThrow();
  });

  it("persists quarantine entries to JSON mirror and reloads across instances", () => {
    const { store, file } = makeTempStore();
    store.add({
      op_id: "op_persist_1",
      tool: "ae_run_jsx",
      label: "Add solids",
      reason: "Timed out after 120s",
    });

    expect(fs.existsSync(file)).toBe(true);

    // Create a second instance pointing at the same JSON file (simulating server restart)
    const reloaded = new QuarantineStore(file);
    expect(reloaded.isQuarantined).toBe(true);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.get("op_persist_1")?.tool).toBe("ae_run_jsx");
    expect(() => reloaded.assertClear()).toThrow(QuarantineBlockedError);

    // Acknowledge on reloaded instance and verify disk mirror updates
    reloaded.acknowledge("op_persist_1", "Checked comp, layers did not land");
    const thirdInstance = new QuarantineStore(file);
    expect(thirdInstance.isQuarantined).toBe(false);
    expect(thirdInstance.list()).toHaveLength(0);
  });
});
