# v0.2: MCP hosted inside the panel

Goal: someone installs the ZXP, opens AE, clicks **Copy setup command** and pastes it once. They need no Node, npm or git.
The panel serves MCP itself at `http://127.0.0.1:7790/mcp`.

## Measured constraints (2026-10-27)
- AE 26 CEP panels run **Node v17.7.2**, Chromium 99, modules ABI 102.
- `@modelcontextprotocol/sdk` 1.32 requires Node ≥ 18. Its Streamable HTTP transport crashes on 17.7.2 (`@hono/node-server` needs a global `Headers`).
  **So the panel uses no SDK at runtime.** We implement the small MCP subset ourselves.
- Node 17 has no global `fetch`. The panel calls `evalScript` directly, so it doesn't need it.
- Only pure-JS dependencies (no native modules). zod 3 is fine.
- Every child process spawned from the panel must use `windowsHide: true` (AE is a GUI app; see the Sequence Archiver bug).

## Architecture

```
server/src/
  host.ts          NEW  HostTransport interface: evalRaw({id, script, label, timeoutMs, mutates, toolName})
  bridge.ts        BridgeClient implements HostTransport over HTTP (dev / stdio path, unchanged behaviour)
  panel-host.ts    NEW  PanelHost implements HostTransport by calling an injected evalScript function
  mcp-rpc.ts       NEW  JSON-RPC MCP handler: pure function handleRpc(message, ctx) -> response | null
  panel-entry.ts   NEW  createPanelMcp({ evalScript, dataDir, log }) -> { handleHttp(req, res, bodyText) }
  index.ts         stdio entry (kept for dev until v0.2 is verified live; then removed)
  tools/*.ts       unchanged, except they take ctx.bridge: HostTransport (health() is optional)
```

### HostTransport
```ts
export interface HostTransport {
  newOpId(): string;
  evalRaw<T = unknown>(p: { id: string; script: string; label: string; timeoutMs?: number;
                           mutates?: boolean; toolName?: string }): Promise<EvalSuccessResponse<T>>;
  callHost<T = unknown>(fn: HostFunctionName, args: unknown, opts: CallHostOptions):
    Promise<{ id: string; result: T; durationMs: number }>;
  health?(): Promise<PanelHealth>;
}
```
`PanelHost` gets `evalScript: (script: string, label: string) => Promise<{ok:true,result:unknown,durationMs:number} | {ok:false,error:{message,kind,line?,actual?,expected?}}>` from the panel. That's the panel's existing FIFO queue, which wraps and parses exactly as `/eval` does today.

`PanelHost` keeps BridgeClient's semantics:
- A timeout races the promise. On timeout it answers `kind:"timeout"`, quarantines the op if it mutates, and **never cancels** the evalScript. The panel queue keeps running it.
- Error kinds are normalised the same way.
- The quarantine check before mutations is unchanged.
- `ae_status` calls `health()` if it exists. Otherwise it reports `{ok:true, transport:"panel"}`.

### MCP JSON-RPC subset (`mcp-rpc.ts`)
Streamable HTTP, **stateless** (no session ids), JSON responses only (no SSE).
- `initialize` → `{protocolVersion, capabilities:{tools:{listChanged:false}}, serverInfo:{name:"chroma-ae-mcp", version}}`.
  Echo the client's `protocolVersion` if it is one of `["2025-06-18","2025-03-26","2024-11-05"]`, else answer `"2025-06-18"`.
- `notifications/initialized` and any other notification (no `id`) → no response. HTTP 202, empty body.
- `ping` → `{}`
- `tools/list` → `{tools:[{name, description, inputSchema}]}`, using the existing `zodToJsonSchema` (move it out of index.ts into a shared module).
- `tools/call` → parse the args with the tool's zod schema, then run the handler. Return `{content:[{type:"text",text}], isError?}` using the existing `formatToolResponse` / `formatToolError`.
- Unknown method → JSON-RPC error `-32601`. Bad JSON → `-32700`. Bad params → `-32602`.
- Batch arrays: handle each element and return an array of the non-null responses.
- HTTP: `POST /mcp` only. `GET /mcp` → 405 with `Allow: POST`. Response `Content-Type: application/json`.

### Panel changes (`panel/client/main.js`)
- `require()` the bundle `panel/client/mcp-bundle.cjs` (built from `panel-entry.ts` by esbuild: CJS, `platform: node`, `target: node17`, zod bundled in). Call `createPanelMcp` once, passing the panel's own eval-queue function as `evalScript`.
- Route `POST /mcp` and `GET /mcp` through the same security checks as today: reject any Origin header, enforce the strict Host, require the Bearer token. Then call `handleHttp`.
- **Stable token:**
  - On first run, generate the token and write it with the same private ACL. On later runs, read it back.
  - Stop deleting it on shutdown.
  - Add a **Regenerate token** button that rewrites the file and warns that the setup command must be pasted again.
- **Copy setup command** button. It copies
  `claude mcp add --scope user --transport http chroma-ae http://127.0.0.1:7790/mcp --header "Authorization: Bearer <token>"`
  to the clipboard (CEP: `navigator.clipboard` or a textarea plus `document.execCommand("copy")`). Show the command with the token masked.
- `/health` and `/eval` stay for the dev stdio path and for diagnostics.

### Build
- `server/package.json`: add `esbuild` (devDep) and the script
  `"bundle": "esbuild src/panel-entry.ts --bundle --platform=node --target=node17 --format=cjs --outfile=../panel/client/mcp-bundle.cjs"`.
- The bundle is a build output. Commit it for now, so a junctioned dev panel works without a build step. CI checks it is up to date.

### Tests (vitest, Node 20)
- `mcp-rpc.test.ts`: initialize version negotiation, notifications → null, tools/list has 12 tools with object schemas, tools/call with bad args → `isError`, unknown method → -32601, batch.
- `panel-host.test.ts`: success; error-kind mapping; timeout → `kind:"timeout"` plus quarantine for a mutation, and the underlying promise is not cancelled.
- CI job `cep-node`: run `panel/client/mcp-bundle.cjs` under Node 17.7.2 with a fake `evalScript`. Initialize, list tools, and call `ae_get_comp`; it must reach the fake evalScript with `__chromaAe.getComp(...)`.

## Later in v0.2 (not this slice)
- A background extension that starts at AE launch (CEP `StartOn` events), so the MCP is live even with the panel closed.
- A signed ZXP via `release.ps1` and `op-sa`, a version check against a manifest, and the attribution/notices in the package.
