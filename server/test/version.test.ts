import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../src/mcp-rpc.js";

// VERSION is the source of truth (scripts/package.ps1 stamps the ZXP from it).
// The server's own numbers drifted to 0.1.0, 0.2.0 and 0.2.1 before this test.
describe("version", () => {
  const repo = path.resolve(__dirname, "../..");
  const version = fs.readFileSync(path.join(repo, "VERSION"), "utf8").trim();

  it("matches VERSION in the MCP serverInfo and server/package.json", () => {
    expect(SERVER_VERSION).toBe(version);
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "server/package.json"), "utf8"));
    expect(pkg.version).toBe(version);
    const lock = JSON.parse(fs.readFileSync(path.join(repo, "server/package-lock.json"), "utf8"));
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
  });

  it("matches VERSION in the panel manifest, so a dev install reports the real version", () => {
    // package.ps1 stamps the ZXP's copy too; the checked-in one is what a dev junction or link loads.
    const manifest = fs.readFileSync(path.join(repo, "panel/CSXS/manifest.xml"), "utf8");
    expect(manifest).toContain(`ExtensionBundleVersion="${version}"`);
    const ids = [...manifest.matchAll(/<Extension Id="([^"]+)" Version="([^"]+)"/g)];
    expect(ids.length).toBeGreaterThan(0);
    for (const m of ids) expect(m[2], m[1]).toBe(version);
  });
});
