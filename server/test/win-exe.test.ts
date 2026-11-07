import { describe, expect, it } from "vitest";
import { powershellExe } from "../src/win-exe.js";

describe("powershellExe", () => {
  it("is the System32 copy by absolute path when it exists", () => {
    const p = powershellExe({ SystemRoot: "D:\\Win" } as NodeJS.ProcessEnv, () => true);
    expect(p).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
  it("falls back to the bare name when that copy is missing or the check throws", () => {
    expect(powershellExe({ SystemRoot: "D:\\Win" } as NodeJS.ProcessEnv, () => false)).toBe("powershell.exe");
    expect(
      powershellExe({} as NodeJS.ProcessEnv, () => {
        throw new Error("denied");
      })
    ).toBe("powershell.exe");
  });
  it("uses C:\\Windows when no SystemRoot is set", () => {
    expect(powershellExe({} as NodeJS.ProcessEnv, () => true)).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
});
