/**
 * AE 26.3 (26.3x87, measured 2026-11-26, PR #19): an Advanced 3D comp with an environment light whose
 * image comes from a layer, plus another enabled 3D layer, never finishes rendering, and AE then writes
 * no frame until it is restarted. core.jsx refuses such a comp before saveFrameToPng; the server passes
 * the refusal on at once, without waiting for a file or holding later frames.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/tools/common.js";
import { captureCompFrame } from "../src/tools/ext/frames.js";
import { AeSnapshotFrameSchema, renderHangMessage, renderTools, unwrittenFrameHold } from "../src/tools/render.js";
import { SingleWriterQueue } from "../src/queue.js";
import { FakeLayer, FakeProject, LightType, loadHost, type FakeComp } from "./support/fake-ae.js";

const ENV = 4416;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function scene(o: { version?: string; renderer?: string; source?: boolean; lightOn?: boolean; card3d?: boolean } = {}) {
  const project = new FakeProject();
  const comp = project.addComp("W5 3D", 640, 360, 4);
  (comp as any).renderer = o.renderer ?? "ADBE Advanced 3d";
  const hdri = comp.layers.addSolid([0.5, 0.5, 0.5], "HDRI", 640, 360, 1) as FakeLayer;
  const env = comp.layers.addLight("Env", [320, 180]) as FakeLayer;
  env.lightType = ENV;
  (env as any).lightSource = o.source === false ? null : hdri;
  env.enabled = o.lightOn !== false;
  const card = comp.layers.addSolid([0.2, 0.6, 0.9], "Card", 300, 200, 1) as FakeLayer;
  card.threeDLayer = o.card3d !== false;
  const { A, G } = loadHost(project, [], { version: o.version ?? "26.3x87" });
  G.LightType = { ...LightType, ENVIRONMENT: ENV };
  let saved = 0;
  (comp as any).saveFrameToPng = () => saved++;
  return { project, comp, A, G, saves: () => saved };
}

describe("core.jsx: the AE 26.3 environment-light render hang", () => {
  it("finds an environment light with a layer source and a 3D layer it lights, in an Advanced 3D comp", () => {
    const { comp, A } = scene();
    expect(A.envLightRenderHazard(comp)).toMatchObject({ comp_id: comp.id, comp_name: "W5 3D", light: "Env", layer: "Card" });
  });

  it("leaves alone what renders on 26.3: no source, the light off, no other 3D layer, Classic 3D, and AE before 26.3", () => {
    for (const o of [{ source: false }, { lightOn: false }, { card3d: false }, { renderer: "ADBE Ernst" }, { version: "26.2.1" }, { version: "25.5" }]) {
      const { comp, A } = scene(o);
      expect(A.envLightRenderHazard(comp), JSON.stringify(o)).toBeNull();
    }
  });

  it("finds it in a precomp, which renders as part of its parent", () => {
    const { project, comp, A } = scene();
    const parent: FakeComp = project.addComp("Edit", 1920, 1080, 4);
    (parent as any).renderer = "ADBE Ernst";
    parent.layers.add(comp);
    expect(A.envLightRenderHazard(parent)).toMatchObject({ comp_id: comp.id, light: "Env", layer: "Card" });
  });

  it("snapshotFrame refuses before saveFrameToPng, and renders a comp without the hazard", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chroma-hang-"));
    dirs.push(dir);
    const bad = scene();
    const r = bad.A.snapshotFrame({ comp_id: bad.comp.id, time: 0, output_path: path.join(dir, "a.png") });
    expect(r).toMatchObject({ refused: "render_hang_env_light", hazard: { light: "Env" }, ae_version: "26.3x87" });
    expect(bad.saves()).toBe(0);
    const ok = scene({ source: false });
    const r2 = ok.A.snapshotFrame({ comp_id: ok.comp.id, time: 0, output_path: path.join(dir, "b.png") });
    expect(r2.refused).toBeUndefined();
    expect(ok.saves()).toBe(1);
  });
});

describe("the server passes the refusal on at once", () => {
  const hazard = { comp_id: 7, comp_name: "W5 3D", light: "Env", layer: "Card" };
  const refusingAe = () => {
    const sent: string[] = [];
    const queue = new SingleWriterQueue();
    const ctx = {
      queue,
      bridge: {
        newOpId: () => "op_test",
        evalRaw: async ({ script }: { script: string }) => {
          sent.push(script);
          return { result: { refused: "render_hang_env_light", hazard, ae_version: "26.3x87", time: 0, width: 640, height: 360 } };
        },
      },
    } as unknown as ToolContext;
    return { ctx, sent };
  };

  it("ae_snapshot_frame: render_hang_env_light, nothing waited for, no hold on later frames", async () => {
    const { ctx, sent } = refusingAe();
    const tool = renderTools.find((t) => t.name === "ae_snapshot_frame")!;
    const t0 = Date.now();
    const r: any = await tool.handler(AeSnapshotFrameSchema.parse({ comp_id: 7, time: 0 }), ctx);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r).toMatchObject({ ok: false, error: "render_hang_env_light", rendered: false, hazard });
    expect(r.message).toMatch(/never finishes rendering "W5 3D" \(comp 7\).*"Env" takes its image from a layer.*"Card"/);
    expect(sent).toHaveLength(1);
    expect(unwrittenFrameHold()).toBeNull();
  });

  it("captureCompFrame (every tool that renders frames) throws the same message and sends nothing more", async () => {
    const { ctx, sent } = refusingAe();
    const err = await captureCompFrame({ ctx, opId: "op", compId: 7, time: 0, frameIndex: 0, framesDir: os.tmpdir(), waitMs: 100 }).catch((e) => e);
    expect(String(err.message)).toBe(renderHangMessage(hazard, "26.3x87"));
    expect(sent).toHaveLength(1);
    expect(unwrittenFrameHold()).toBeNull();
  });
});
