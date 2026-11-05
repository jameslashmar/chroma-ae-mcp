import { describe, expect, it } from "vitest";
import {
  buildJsxCall,
  encodeJsxArg,
  HOST_FUNCTIONS,
  normalizeGuardPath,
  pathsMatchForGuard,
} from "../src/jsx.js";

describe("Guard path normalisation", () => {
  it("normalises Windows paths case-insensitively and converts backslashes to forward slashes", () => {
    expect(
      normalizeGuardPath("C:\\Projects\\Chroma\\Scene_01.aep\\", true)
    ).toBe("c:/projects/chroma/scene_01.aep");
    expect(
      pathsMatchForGuard(
        "C:\\Projects\\Chroma\\Scene_01.aep",
        "c:/projects/chroma/scene_01.aep",
        true
      )
    ).toBe(true);
  });

  it("preserves case on non-Windows while normalising slashes", () => {
    expect(normalizeGuardPath("/Users/Jay/Project.aep/", false)).toBe(
      "/Users/Jay/Project.aep"
    );
    expect(
      pathsMatchForGuard(
        "/Users/Jay/Project.aep",
        "/users/jay/project.aep",
        false
      )
    ).toBe(false);
  });

  it("handles <unsaved> project guard accurately", () => {
    expect(normalizeGuardPath("<unsaved>", true)).toBe("<unsaved>");
    expect(pathsMatchForGuard("<unsaved>", null, true)).toBe(true);
    expect(pathsMatchForGuard("<unsaved>", "<unsaved>", true)).toBe(true);
    expect(
      pathsMatchForGuard("C:/Projects/Saved.aep", "<unsaved>", true)
    ).toBe(false);
    expect(
      pathsMatchForGuard("<unsaved>", "C:/Projects/Saved.aep", true)
    ).toBe(false);
  });
});

describe("JSX escaping and call-string builder", () => {
  it("escapes quotes, backslashes, newlines, tabs, and unicode characters safely", () => {
    const tricky = {
      code: 'var s = "hello \\"world\\"";\nvar path = "C:\\\\Temp\\\\file.txt";\r\nvar sep = "\u2028\u2029";\nvar emoji = "🎬 — £100 — 日本語";',
    };

    const encoded = encodeJsxArg(tricky);
    // Must be pure ASCII without raw newlines or raw non-ASCII characters
    expect(encoded).not.toContain("\n");
    expect(encoded).not.toContain("\r");
    expect(encoded).not.toContain("\u2028");
    expect(encoded).not.toContain("\u2029");
    for (let i = 0; i < encoded.length; i++) {
      expect(encoded.charCodeAt(i)).toBeGreaterThanOrEqual(0x20);
      expect(encoded.charCodeAt(i)).toBeLessThanOrEqual(0x7e);
    }

    // Evaluating the JS literal (as ExtendScript does) must round-trip identically
    const roundTripped = JSON.parse(
      // Replace \uXXXX escapes via JSON.parse since valid JSON supports \uXXXX
      encoded
    );
    expect(roundTripped).toEqual(tricky);
  });

  it("builds __chromaAe.<fn>(...) calls for all 14 host functions", () => {
    expect(HOST_FUNCTIONS).toEqual([
      "status",
      "getProject",
      "getComp",
      "getLayerProps",
      "runUserJsx",
      "setProperty",
      "snapshotFrame",
      "rqAdd",
      "rqStatus",
      "save",
      "snapshotForReceipt",
      "checkGuard",
      "statusDetail",
      "fontsResolve",
    ]);

    const callStr = buildJsxCall("setProperty", {
      comp_id: 12,
      path: ["Transform", "Opacity"],
      value: 75,
    });
    expect(callStr).toBe(
      '__chromaAe.setProperty({"comp_id":12,"path":["Transform","Opacity"],"value":75})'
    );
  });
});
