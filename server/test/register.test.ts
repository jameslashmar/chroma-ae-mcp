import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const register = require("../../panel/tools/register.cjs");

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake machine: its own home, a node binary on PATH, the relay, and a recording exec. */
function fakeEnv(platform: string = process.platform) {
  const home = tempDir("chroma-reg-home-");
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const nodeName = platform === "win32" ? "node.exe" : "node";
  fs.writeFileSync(path.join(bin, nodeName), "");
  const relayPath = path.join(home, "ext", "tools", "stdio-relay.cjs");
  fs.mkdirSync(path.dirname(relayPath), { recursive: true });
  fs.writeFileSync(relayPath, "");
  const execs: Array<{ file: string; args: string[] }> = [];
  const env = {
    platform,
    home,
    appData: path.join(home, "AppData", "Roaming"),
    pathEnv: bin,
    dirs: { node: [], claude: [] },
    relayPath,
    exec: async (file: string, args: string[]) => {
      execs.push({ file, args });
      return { status: 0, stdout: "ok", stderr: "" };
    },
  };
  return { env, execs, node: path.join(bin, nodeName), relayPath };
}

describe("register.cjs config editing", () => {
  it("adds, replaces and removes the chroma-ae table in Codex's TOML, leaving the rest alone", () => {
    const table = register.codexTable("C:\\Program Files\\nodejs\\node.exe", "C:\\ext\\tools\\stdio-relay.cjs");
    expect(table).toEqual([
      "[mcp_servers.chroma-ae]",
      "command = 'C:\\Program Files\\nodejs\\node.exe'",
      "args = ['C:\\ext\\tools\\stdio-relay.cjs']",
    ]);
    const original = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const added = register.upsertTomlTable(original, table);
    expect(added).toBe(original + "\n" + table.join("\n") + "\n");
    const withSub = added.replace(/\n$/, "") + "\n\n[mcp_servers.chroma-ae.env]\nA = '1'\n\n[profiles.x]\nmodel = 'y'\n";
    const replaced = register.upsertTomlTable(withSub, ["[mcp_servers.chroma-ae]", "command = 'n'"]);
    expect(replaced).toContain("[mcp_servers.other]");
    expect(replaced).toContain("[profiles.x]");
    expect(replaced).not.toContain("A = '1'");
    expect(replaced.match(/chroma-ae/g)).toHaveLength(1);
    const removed = register.upsertTomlTable(replaced, null);
    expect(removed).not.toContain("chroma-ae");
    expect(removed).toContain("[mcp_servers.other]");
    expect(register.tomlString("it's")).toBe('"it\'s"');
  });

  it("registers Claude Desktop, Cursor and Codex with the relay, backing up, and removes them again", async () => {
    const { env, node, relayPath } = fakeEnv();
    const desktop = path.join(env.appData, "Claude", "claude_desktop_config.json");
    fs.mkdirSync(path.dirname(desktop), { recursive: true });
    fs.writeFileSync(desktop, JSON.stringify({ mcpServers: { blender: { command: "uvx" } }, theme: "dark" }));

    expect(register.status(env).every((c: any) => !c.registered)).toBe(true);
    for (const id of ["claude-desktop", "cursor", "codex"]) await register.setRegistered(id, true, {}, env);

    const d = JSON.parse(fs.readFileSync(desktop, "utf8"));
    // Only Claude Desktop's entry asks the relay for the core toolset.
    expect(d.mcpServers["chroma-ae"]).toEqual({ command: node, args: [relayPath], env: { CHROMA_AE_MCP_TOOLSET: "core" } });
    expect(d.mcpServers.blender).toEqual({ command: "uvx" });
    expect(d.theme).toBe("dark");
    expect(fs.existsSync(desktop + ".chroma-bak")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(env.home, ".cursor", "mcp.json"), "utf8")).mcpServers["chroma-ae"].args).toEqual([relayPath]);
    expect(fs.readFileSync(path.join(env.home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.chroma-ae]");

    const st = Object.fromEntries(register.status(env).map((c: any) => [c.id, c.registered]));
    expect(st).toEqual({ "claude-code": false, "claude-desktop": true, cursor: true, codex: true });

    for (const id of ["claude-desktop", "cursor", "codex"]) await register.setRegistered(id, false, {}, env);
    expect(register.status(env).every((c: any) => !c.registered)).toBe(true);
    expect(JSON.parse(fs.readFileSync(desktop, "utf8")).mcpServers.blender).toBeDefined();
  });

  it("writes CHROMA_AE_MCP_TOOLSET=core into the Claude Desktop entry only", async () => {
    const { env, execs, node, relayPath } = fakeEnv();
    fs.writeFileSync(path.join(env.pathEnv, process.platform === "win32" ? "claude.exe" : "claude"), "");
    for (const id of ["claude-desktop", "cursor", "codex", "claude-code"]) await register.setRegistered(id, true, { port: 7790, token: "t" }, env);

    const desktop = JSON.parse(fs.readFileSync(path.join(env.appData, "Claude", "claude_desktop_config.json"), "utf8"));
    expect(desktop.mcpServers["chroma-ae"].env).toEqual({ CHROMA_AE_MCP_TOOLSET: "core" });
    const cursor = JSON.parse(fs.readFileSync(path.join(env.home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers["chroma-ae"]).toEqual({ command: node, args: [relayPath] });
    expect(fs.readFileSync(path.join(env.home, ".codex", "config.toml"), "utf8")).not.toContain("TOOLSET");
    // Claude Code registration is the HTTP command, with no toolset.
    expect(execs.map((e) => e.args.join(" ")).join(" | ")).not.toContain("TOOLSET");
    expect(register.setupText("claude-code", { port: 7790, token: "t" }, env).text).not.toContain("TOOLSET");
    expect(register.setupText("cursor", {}, env).text).not.toContain("TOOLSET");
    expect(register.setupText("codex", {}, env).text).not.toContain("TOOLSET");
    expect(register.setupText("claude-desktop", {}, env).text).toContain("CHROMA_AE_MCP_TOOLSET");
  });

  it("keeps the user's own env and toolset choice when Claude Desktop is registered again", async () => {
    const { env, node, relayPath } = fakeEnv();
    const file = path.join(env.appData, "Claude", "claude_desktop_config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { "chroma-ae": { command: "old", args: ["x"], env: { CHROMA_AE_MCP_PORT: "7791", CHROMA_AE_MCP_TOOLSET: "full" } } } }));
    await register.setRegistered("claude-desktop", true, {}, env);
    let entry = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["chroma-ae"];
    expect(entry).toEqual({ command: node, args: [relayPath], env: { CHROMA_AE_MCP_PORT: "7791", CHROMA_AE_MCP_TOOLSET: "full" } });

    // An entry with no toolset (never set, or removed on purpose: the two cannot be told apart) is NOT given core
    // again by a plain re-registration. Its other env and keys are kept.
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { "chroma-ae": { command: "old", disabled: false, env: { CHROMA_AE_MCP_PORT: "7791" } } } }));
    const message = await register.setRegistered("claude-desktop", true, {}, env);
    entry = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["chroma-ae"];
    expect(entry).toEqual({ command: node, args: [relayPath], disabled: false, env: { CHROMA_AE_MCP_PORT: "7791" } });
    // The message describes the env that was written, not what was intended.
    expect(message).toContain("lists all tools");
    expect(message).not.toContain("core toolset");

    // No env at all: still no env key and no core.
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { "chroma-ae": { command: "old" } } }));
    await register.setRegistered("claude-desktop", true, {}, env);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["chroma-ae"]).toEqual({ command: node, args: [relayPath] });
  });

  it("the panel's explicit Claude Desktop action adds core to an existing entry, keeping its other keys, with a backup", async () => {
    const { env, node, relayPath } = fakeEnv();
    const file = path.join(env.appData, "Claude", "claude_desktop_config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = { theme: "dark", mcpServers: { blender: { command: "uvx" }, "chroma-ae": { command: "old", disabled: false, env: { CHROMA_AE_MCP_PORT: "7791" } } } };
    fs.writeFileSync(file, JSON.stringify(original));

    let st = register.status(env).find((c: any) => c.id === "claude-desktop");
    expect(st).toMatchObject({ registered: true, toolset: "unset" });
    expect(register.desktopState(env)).toEqual({ registered: true, toolset: "unset" });

    const message = await register.setRegistered("claude-desktop", true, { toolset: "core" }, env);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.mcpServers["chroma-ae"]).toEqual({
      command: node,
      args: [relayPath],
      disabled: false,
      env: { CHROMA_AE_MCP_PORT: "7791", CHROMA_AE_MCP_TOOLSET: "core" },
    });
    expect(written.mcpServers.blender).toEqual({ command: "uvx" });
    expect(written.theme).toBe("dark");
    expect(JSON.parse(fs.readFileSync(file + ".chroma-bak", "utf8"))).toEqual(original);
    expect(message).toContain("core toolset");
    expect(message).toMatch(/Quit Claude Desktop .* reopen/);
    st = register.status(env).find((c: any) => c.id === "claude-desktop");
    expect(st).toMatchObject({ registered: true, toolset: "core" });

    // A value the user set is never overwritten, even by the explicit action.
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { "chroma-ae": { command: "old", env: { CHROMA_AE_MCP_TOOLSET: "full" } } } }));
    const keep = await register.setRegistered("claude-desktop", true, { toolset: "core" }, env);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["chroma-ae"].env).toEqual({ CHROMA_AE_MCP_TOOLSET: "full" });
    expect(keep).toContain("CHROMA_AE_MCP_TOOLSET=full kept");
    expect(register.desktopState(env)).toEqual({ registered: true, toolset: "full" });
  });

  it("adds a new Claude Desktop entry with core, and reports no registration before that", async () => {
    const { env } = fakeEnv();
    expect(register.desktopState(env)).toEqual({ registered: false, toolset: "unset" });
    const message = await register.setRegistered("claude-desktop", true, { toolset: "core" }, env);
    expect(message).toMatch(/^Added to Claude Desktop with the core toolset/);
    expect(register.desktopState(env)).toEqual({ registered: true, toolset: "core" });
    expect(register.status(env).filter((c: any) => c.id !== "claude-desktop").every((c: any) => c.toolset === undefined)).toBe(true);
  });

  it("is wired into the panel: a Claude Desktop button that calls the explicit action", () => {
    const panelDir = path.resolve(__dirname, "../../panel/client");
    const js = fs.readFileSync(path.join(panelDir, "panel.js"), "utf8");
    const html = fs.readFileSync(path.join(panelDir, "index.html"), "utf8");
    expect(html).toContain('id="write-desktop-btn"');
    expect(js).toMatch(/setRegistered\("claude-desktop", true, \{ toolset: "core" \}\)/);
    // An existing entry without the variable gets the offer, not only "already has chroma-ae".
    expect(js).toContain('entry.toolset === "unset"');
    expect(js).toContain("Use the core toolset in Claude Desktop");
    expect(js).toMatch(/reopen it/);
    // Node 17.7.2 in the panel: no optional chaining, let/const or arrows in the new code.
    expect(js.slice(js.indexOf("function bindDesktopAction"), js.indexOf("function bindDesktopAction") + 900)).not.toMatch(/=>|\blet\b|\bconst\b|\?\./);
  });

  it("registers Claude Code through its CLI with the token, replacing an old entry", async () => {
    const { env, execs } = fakeEnv();
    fs.writeFileSync(path.join(env.pathEnv, process.platform === "win32" ? "claude.exe" : "claude"), "");
    const token = "c".repeat(64);
    await register.setRegistered("claude-code", true, { port: 7790, token }, env);
    expect(execs.map((e) => e.args.slice(0, 2).join(" "))).toEqual(["mcp remove", "mcp add"]);
    expect(execs[1].args).toEqual(["mcp", "add", "--scope", "user", "--transport", "http", "chroma-ae", "http://127.0.0.1:7790/mcp", "--header", `Authorization: Bearer ${token}`]);
  });

  it("explains a missing Node or Claude Code CLI, and never leaks the token in errors", async () => {
    const { env } = fakeEnv();
    const noNode = { ...env, pathEnv: "", home: tempDir("chroma-reg-empty-") };
    await expect(register.setRegistered("cursor", true, {}, noNode)).rejects.toThrow(/Node\.js was not found/);
    await expect(register.setRegistered("claude-code", true, { port: 7790, token: "x" }, noNode)).rejects.toThrow(/CLI was not found/);
    const token = "d".repeat(64);
    const failing = { ...env, exec: async () => ({ status: 1, stdout: `bad header Bearer ${token} and again ${token}`, stderr: "" }) };
    fs.writeFileSync(path.join(env.pathEnv, process.platform === "win32" ? "claude.exe" : "claude"), "");
    let msg = "";
    try {
      await register.setRegistered("claude-code", true, { port: 7790, token }, failing);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/claude mcp add failed/);
    expect(msg).not.toContain(token);
  });

  it("restores the old Claude Code http entry when the new add fails", async () => {
    const { env } = fakeEnv();
    fs.writeFileSync(path.join(env.pathEnv, process.platform === "win32" ? "claude.exe" : "claude"), "");
    const oldToken = "a".repeat(64);
    const claudeJsonPath = path.join(env.home, ".claude.json");
    const oldEntry = { type: "http", url: "http://127.0.0.1:7790/mcp", headers: { Authorization: `Bearer ${oldToken}` } };
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { "chroma-ae": oldEntry } }));
    const calls: string[][] = [];
    const flaky = {
      ...env,
      exec: async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "add") return { status: 1, stdout: "", stderr: "boom" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    await expect(register.setRegistered("claude-code", true, { port: 7790, token: "b".repeat(64) }, flaky)).rejects.toThrow(/old registration was restored/);
    // Restore now writes the raw old entry straight back into ~/.claude.json
    // (through the same backup-first, atomic-rename path the other three
    // hosts use) instead of reconstructing a second `claude mcp add` call,
    // so there is no third exec call to check -- only "mcp remove" then the
    // failing "mcp add".
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["mcp remove", "mcp add"]);
    const restored = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    expect(restored.mcpServers["chroma-ae"]).toEqual(oldEntry);
    expect(fs.existsSync(claudeJsonPath + ".chroma-bak")).toBe(true);
  });

  it("restores a non-http old Claude Code entry too (register.cjs's own stdio pattern, applied by hand)", async () => {
    const { env, relayPath, node } = fakeEnv();
    fs.writeFileSync(path.join(env.pathEnv, process.platform === "win32" ? "claude.exe" : "claude"), "");
    const claudeJsonPath = path.join(env.home, ".claude.json");
    // The shape the restore logic used to only handle for `http`: a `stdio`
    // entry, e.g. one a user set up by hand with `claude mcp add -- node
    // stdio-relay.cjs` before the http-based flow existed.
    const oldEntry = { type: "stdio", command: node, args: [relayPath] };
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { "chroma-ae": oldEntry } }));
    const flaky = {
      ...env,
      exec: async (_f: string, args: string[]) => (args[1] === "add" ? { status: 1, stdout: "", stderr: "boom" } : { status: 0, stdout: "", stderr: "" }),
    };
    await expect(register.setRegistered("claude-code", true, { port: 7790, token: "b".repeat(64) }, flaky)).rejects.toThrow(/old registration was restored/);
    const restored = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    expect(restored.mcpServers["chroma-ae"]).toEqual(oldEntry);
  });

  it("refuses to edit TOML where chroma-ae is defined in another form, and accepts a header comment", () => {
    const table = ["[mcp_servers.chroma-ae]", "command = 'n'"];
    const inline = '[mcp_servers]\nchroma-ae = { command = "x" }\n';
    expect(() => register.upsertTomlTable(inline, table)).toThrow(/by hand/);
    expect(() => register.upsertTomlTable('mcp_servers.chroma-ae.command = "x"\n', null)).toThrow(/by hand/);
    const commented = "[mcp_servers.chroma-ae] # relay\ncommand = 'old'\n";
    const out = register.upsertTomlTable(commented, table);
    expect(out.match(/chroma-ae/g)).toHaveLength(1);
    expect(out).toContain("command = 'n'");
  });

  it("keeps the first backup, writes through symlinks, and explains non-plain JSON", async () => {
    const { env } = fakeEnv();
    const cursor = path.join(env.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(cursor, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
    await register.setRegistered("cursor", true, {}, env);
    await register.setRegistered("cursor", false, {}, env);
    expect(JSON.parse(fs.readFileSync(cursor + ".chroma-bak", "utf8"))).toEqual({ mcpServers: { a: { command: "a" } } });

    fs.writeFileSync(cursor, "{ // note\n}");
    await expect(register.setRegistered("cursor", true, {}, env)).rejects.toThrow(/plain JSON/);
    fs.writeFileSync(cursor, "[]");
    await expect(register.setRegistered("cursor", true, {}, env)).rejects.toThrow(/plain JSON/);

    const real = path.join(env.home, "dotfiles", "mcp.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "{}");
    fs.rmSync(cursor);
    try {
      fs.symlinkSync(real, cursor);
    } catch {
      return; // symlinks not permitted here
    }
    await register.setRegistered("cursor", true, {}, env);
    expect(fs.lstatSync(cursor).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8")).mcpServers["chroma-ae"]).toBeDefined();
  });
});

describe("register.cjs setup text (the panel's Copy button)", () => {
  it("gives Claude Code its claude mcp add command with the token", () => {
    const { env } = fakeEnv();
    const s = register.setupText("claude-code", { port: 7790, token: "abc123" }, env);
    expect(s.kind).toBe("command");
    expect(s.text).toBe(
      'claude mcp add --scope user --transport http chroma-ae http://127.0.0.1:7790/mcp --header "Authorization: Bearer abc123"'
    );
  });

  it("gives Codex a codex mcp add command for the relay, without the token", () => {
    const { env, node, relayPath } = fakeEnv();
    const s = register.setupText("codex", { port: 7790, token: "abc123" }, env);
    expect(s.text).toBe(`codex mcp add chroma-ae -- "${node}" "${relayPath}"`);
    expect(s.text).not.toContain("abc123");
  });

  it("gives Claude Desktop and Cursor an entry that pastes inside mcpServers", () => {
    const { env, node, relayPath } = fakeEnv();
    for (const id of ["claude-desktop", "cursor"]) {
      const s = register.setupText(id, { port: 7790, token: "abc123" }, env);
      expect(s.kind).toBe("config");
      const entry: Record<string, unknown> = { command: node, args: [relayPath] };
      if (id === "claude-desktop") entry.env = { CHROMA_AE_MCP_TOOLSET: "core" };
      expect(JSON.parse("{" + s.text + "}")).toEqual({ "chroma-ae": entry });
      expect(s.where).toContain("mcpServers");
    }
  });

  it("says so when Node is missing", () => {
    const { env } = fakeEnv();
    env.pathEnv = "";
    expect(() => register.setupText("cursor", {}, env)).toThrow(/Node\.js was not found/);
  });
});
