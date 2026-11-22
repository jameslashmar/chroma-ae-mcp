/**
 * The 3D maths behind ae_scene_3d_report, ae_annotate_frame and the camera solve check, against
 * values After Effects itself gave (qa/calibrate-compositing.mjs, projection stage, AE 26.2.1): a
 * one-node and a two-node camera with orientation and X/Y/Z rotation, 3D points, and a rotated,
 * scaled 3D layer's own points through toComp, all at t = 1.2 s of the calibration comps.
 */
import { describe, expect, it } from "vitest";
import { cameraModel, chainMatrix, layerMap, transformPoint, type HostLayer, type Vec3 } from "../src/tools/ext/annotate.js";

const AE = [{"two_node": false, "cam": {"position": [614.6929, 196.5312, -1016.3279], "poi": [480, 270, 0], "orientation": [6.2587, 15.2093, 3.5344], "rx": -4.898, "ry": 7.3469, "rz": 2.449, "zoom": 1183.6735}, "points": [[[180, 120, 200], [-580.719, 328.9329]], [[730, 170, -150], [171.1351, 284.6249]], [[880, 470, 300], [290.6856, 553.9914]], [[600, 10, 500], [-30.5528, 190.2609]]], "q_truth": [[-79.4658, 571.1158], [-287.6091, 588.9701], [-186.1958, 448.3286]]}, {"two_node": true, "cam": {"position": [567.3442, 283.6721, -916.3279], "poi": [504.4898, 257.7551, 61.2245], "orientation": [0, 0, 0], "rx": 3.6735, "ry": -5.5102, "rz": 9.1837, "zoom": 1022.449}, "points": [[[180, 120, 200], [297.0122, 246.6494]], [[730, 170, -150], [858.1423, 145.7041]], [[880, 470, 300], [970.0817, 460.012]], [[600, 10, 500], [649.3008, 136.3219]]], "q_truth": [[637.0447, 426.4671], [484.6188, 423.2608], [547.9595, 327.8714]]}] as const;
const W = 960;
const H = 540;
const F = 1.2 / 1.96;

function setup(c: (typeof AE)[number]) {
  const cam = { id: 1, index: 1, name: "Cam", kind: "camera", three_d: true, parent_id: null, transform: { anchor: [0, 0, 0], position: [...c.cam.position], scale: [100, 100, 100], rotation_z: c.cam.rz, rotation_x: c.cam.rx, rotation_y: c.cam.ry, orientation: [...c.cam.orientation], point_of_interest: c.two_node ? [...c.cam.poi] : null }, camera: { zoom: c.cam.zoom, two_node: c.two_node } } as unknown as HostLayer;
  const lerp = (a: number, b: number) => a + (b - a) * F;
  const q = { id: 2, index: 2, name: "Q", kind: "null", three_d: true, parent_id: null, transform: { anchor: [10, -20, 30], position: [lerp(540, 400), lerp(230, 300), lerp(150, -120)], scale: [120, 80, 150], orientation: [20, -35, 10], rotation_x: lerp(15, -25), rotation_y: lerp(-30, 40), rotation_z: lerp(5, 60) } } as unknown as HostLayer;
  const byId = layerMap([cam, q]);
  const model = cameraModel({ comp: { width: W, height: H }, active_camera_id: 1, layers: [cam, q] } as never, byId);
  const project = (w: Vec3) => {
    const p = transformPoint(model.view, w);
    return [W / 2 + (p[0] / p[2]) * model.zoom, H / 2 + (p[1] / p[2]) * model.zoom];
  };
  return { project, q: chainMatrix(q, byId).matrix! };
}

describe("3D projection matches After Effects", () => {
  it.each(AE.map((c) => [c.two_node ? "two-node" : "one-node", c] as const))("%s camera: points land where AE's toComp puts them", (_n, c) => {
    const { project } = setup(c);
    for (const [world, ae] of c.points) {
      const s = project(world as unknown as Vec3);
      expect(Math.hypot(s[0] - ae[0], s[1] - ae[1])).toBeLessThan(0.01);
    }
  });

  it.each(AE.map((c) => [c.two_node ? "two-node" : "one-node", c] as const))("%s camera: a rotated, scaled 3D layer's own points too", (_n, c) => {
    const { project, q } = setup(c);
    const local: Vec3[] = [[100, 0, 0], [0, 80, 0], [40, -60, 90]];
    local.forEach((p, i) => {
      const s = project(transformPoint(q, p));
      expect(Math.hypot(s[0] - c.q_truth[i][0], s[1] - c.q_truth[i][1])).toBeLessThan(0.05);
    });
  });
});
