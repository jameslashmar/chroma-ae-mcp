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
});
