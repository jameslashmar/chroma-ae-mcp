#!/usr/bin/env node
// qa/live-reliability.mjs: live check of write outcomes and idempotency keys against the panel on
// this machine (Windows or macOS).
//
//   node qa/live-reliability.mjs
//
// Needs an unsaved scratch project open in After Effects (it adds a few comps to it and leaves them).
// Prints one line per check and exits 1 on any failure; no token or paths in the output.
import { DEFAULT_HOST, DEFAULT_PORT, readToken } from "./client.js";

const TOKEN = readToken();
const URL_MCP = `http://${DEFAULT_HOST}:${Number(process.env.CHROMA_AE_MCP_PORT) || DEFAULT_PORT}/mcp`;
let id = 0;
async function call(name, args = {}) {
  const res = await fetch(URL_MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  const text = j.result?.content?.[0]?.text ?? "{}";
  return { isError: j.result?.isError === true, body: JSON.parse(text) };
}
let pass = 0;
let fail = 0;
function check(name, ok, note) {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${note ?? ""}`.slice(0, 260));
}
const brief = (b) => JSON.stringify({ outcome: b.outcome, code: b.code, kind: b.kind, msg: String(b.message ?? "").slice(0, 90), next: (b.next_steps ?? []).length });

const st = (await call("ae_status")).body;
if (st.project_path !== "<unsaved>") throw new Error("needs an unsaved scratch project");
const RUN = String(Date.now()).slice(-6);
const expect = { project_path: "<unsaved>" };

// 1. A refusal before anything is touched (no such comp): not_applied, with the host's code kept.
let r = await call("ae_create_layer", { comp_id: 999999, type: "null", expect });
check("host error before the undo group -> not_applied", r.isError && r.body.outcome === "not_applied", brief(r.body));

// 1b. A host error before the undo group: a layer that is not in the comp (after 3 made the comp, see below).
// 2. A guard failure: not_applied, the write never sent.
r = await call("ae_create_comp", { name: "Guarded " + RUN, mode: "new", width: 100, height: 100, duration: 1, fps: 25, expect: { project_path: "/nope/other.aep" } });
check("guard failure -> not_applied", r.isError && r.body.kind === "guard" && r.body.outcome === "not_applied", brief(r.body));

// 3. A success: outcome applied.
r = await call("ae_create_comp", { name: "Outcome A " + RUN, mode: "new", width: 100, height: 100, duration: 1, fps: 25, expect });
check("success -> applied", !r.isError && r.body.outcome === "applied", brief(r.body));

const compId = ((await call("ae_get_project", { type: "comp", name_contains: "Outcome A " + RUN })).body.items ?? [])[0]?.id;
r = await call("ae_layer_ops", { comp_id: compId, action: "delete", layers: [{ name: "No Such Layer" }], expect: { ...expect, comp_id: compId } });
check("host refusal before the undo group (no such layer) -> not_applied", r.isError ? r.body.outcome === "not_applied" : r.body.outcome === "not_applied" || r.body.applied === false, brief(r.body) + " comp " + compId);

// 4. A write that fails part-way (a comp made, then an error inside the same undo group): unknown, and the comp is really there.
r = await call("ae_run_jsx", { mutates: true, label: "qa outcome: half write", expect, code: "app.project.items.addComp('Half Written " + RUN + "', 100, 100, 1, 1, 25); throw new Error('boom after the first change');" });
const half = (await call("ae_get_project", { type: "comp", name_contains: "Half Written " + RUN })).body;
check("error after a change -> unknown, with undo/checkpoint steps", r.isError && r.body.outcome === "unknown" && (r.body.next_steps ?? []).join(" ").includes("Ctrl+Z"), brief(r.body));
check("... and the half write is really in the project (why unknown matters)", (half.items ?? []).length === 1, `${(half.items ?? []).length} 'Half Written ' + RUN comp(s)`);

// 5. Idempotency: the same key twice makes one comp.
const key = `live-${Date.now()}`;
const a = await call("ae_create_comp", { name: "Keyed " + RUN, mode: "new", width: 100, height: 100, duration: 1, fps: 25, expect, idempotency_key: key });
const b = await call("ae_create_comp", { name: "Keyed " + RUN, mode: "new", width: 100, height: 100, duration: 1, fps: 25, expect, idempotency_key: key });
const keyed = (await call("ae_get_project", { type: "comp", name_contains: "Keyed " + RUN })).body;
check("same key twice -> one write, second replayed", !a.isError && b.body.idempotent_replay === true && (keyed.items ?? []).length === 1, `${(keyed.items ?? []).length} 'Keyed ' + RUN comp(s); replay ${b.body.idempotent_replay}`);

// 6. Same key, other arguments: refused, nothing made.
const c = await call("ae_create_comp", { name: "Keyed Other " + RUN, mode: "new", width: 100, height: 100, duration: 1, fps: 25, expect, idempotency_key: key });
const other = (await call("ae_get_project", { type: "comp", name_contains: "Keyed Other " + RUN })).body;
check("same key, other args -> refused, not run", c.isError && c.body.code === "idempotency_key_reused" && (other.items ?? []).length === 0, brief(c.body));

// 7. Two at once with one key: one comp.
const key2 = `live2-${Date.now()}`;
const both = await Promise.all([1, 2].map(() => call("ae_create_comp", { name: "Parallel " + RUN, mode: "new", width: 100, height: 100, duration: 1, fps: 25, expect, idempotency_key: key2 })));
const par = (await call("ae_get_project", { type: "comp", name_contains: "Parallel " + RUN })).body;
check("two concurrent calls, one key -> one comp", (par.items ?? []).length === 1 && both.some((x) => x.body.idempotent_replay === true), `${(par.items ?? []).length} 'Parallel ' + RUN comp(s)`);

// 8. ae_recent_ops shows them.
const recent = (await call("ae_recent_ops", { limit: 20 })).body;
const outcomes = (recent.ops ?? []).map((o) => `${o.tool}:${o.outcome}${o.idempotent_replay ? "(replay)" : ""}`);
check("ae_recent_ops lists the writes with outcomes", recent.count >= 8 && outcomes.includes("ae_run_jsx:unknown") && outcomes.some((o) => o.endsWith("(replay)")), outcomes.slice(0, 9).join(" "));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
