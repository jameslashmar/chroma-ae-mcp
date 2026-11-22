#!/usr/bin/env node
// qa/cep-freeze-check.mjs: does the panel service keep answering while After Effects runs a long
// ExtendScript, and do kept-alive connections survive it?
//
//   node qa/cep-freeze-check.mjs [--seconds 7]
//
// Sends one harmless raw eval ($.sleep) and, while it runs, asks /health on a fresh connection and on
// a kept-alive one (the way Node 19+ clients, the stdio relay included, reuse sockets). Measured on
// macOS, AE 26.2.1: the service's event loop stops for the whole eval (/health answered after 8.2 s
// for an 8 s eval), and before panel/client/service.js sent "Connection: close" every reused socket
// died with ECONNRESET. Run it on Windows to see whether CEP there keeps answering (the busy refusals
// in ae-activity.ts assume it does). Nothing in the project changes. Exit 1 on a reset.
import http from "node:http";
import { DEFAULT_HOST, DEFAULT_PORT, readToken } from "./client.js";

const i = process.argv.indexOf("--seconds");
const seconds = Math.min(30, Math.max(2, Number(i > 0 ? process.argv[i + 1] : 7) || 7));
const TOKEN = readToken();
const port = Number(process.env.CHROMA_AE_MCP_PORT) || DEFAULT_PORT;
const keep = new http.Agent({ keepAlive: true });
const fresh = new http.Agent({ keepAlive: false });

function req(agent, method, path, body) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = http.request(
      { host: DEFAULT_HOST, port, method, path, agent, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ ms: Date.now() - t0, connection: res.headers.connection }));
      }
    );
    r.on("error", (e) => resolve({ ms: Date.now() - t0, error: e.code ?? e.message }));
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

const warm = await req(keep, "GET", "/health");
if (warm.error) {
  console.error(`The panel service does not answer on port ${port}: ${warm.error}`);
  process.exit(2);
}
console.log(`/health answers in ${warm.ms} ms; Connection: ${warm.connection ?? "(none)"}`);
const eval_ = req(fresh, "POST", "/eval", { id: `qa_freeze_${Date.now()}`, label: `qa: ${seconds} s sleep (freeze check)`, script: `$.sleep(${seconds * 1000}); 1`, raw: true });
await new Promise((r) => setTimeout(r, 300));
const [onFresh, onKept] = await Promise.all([req(fresh, "GET", "/health"), req(keep, "GET", "/health")]);
const done = await eval_;
console.log(`a ${seconds} s eval took ${done.ms} ms`);
console.log(`during it, /health on a new connection: ${onFresh.error ? "ERROR " + onFresh.error : onFresh.ms + " ms"}`);
console.log(`during it, /health on a reused connection: ${onKept.error ? "ERROR " + onKept.error : onKept.ms + " ms"}`);
const frozen = !onFresh.error && onFresh.ms > seconds * 1000 * 0.7;
console.log(frozen ? "RESULT: the service stops answering while AE runs ExtendScript (busy refusals cannot be fast here)." : "RESULT: the service keeps answering while AE runs ExtendScript.");
process.exit(onKept.error || onFresh.error ? 1 : 0);
