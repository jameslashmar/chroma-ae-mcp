/**
 * ae_camera_solve_check's maths: projecting a world point through a camera model, and the local
 * affine a small patch facing the reference camera goes through as the camera moves (the warp of the
 * first frame's pattern). The tool itself was measured live (docs/CALIBRATION.md).
 */
import { describe, expect, it } from "vitest";
import { cameraModel, layerMap, type HostLayer } from "../src/tools/ext/annotate.js";
import { localAffine, projectWorld } from "../src/tools/ext/solvecheck.js";

const comp = { width: 960, height: 540 };
function cam(position: number[], rz = 0, zoom = 1000) {
  const l = { id: 1, index: 1, name: "Cam", kind: "camera", three_d: true, parent_id: null, transform: { anchor: [0, 0, 0], position, scale: [100, 100, 100], rotation_x: 0, rotation_y: 0, rotation_z: rz, orientation: [0, 0, 0], point_of_interest: null }, camera: { zoom, two_node: false } } as unknown as HostLayer;
  return cameraModel({ comp, active_camera_id: 1, layers: [l] } as never, layerMap([l]));
}

describe("camera solve check maths", () => {
  it("projects the point the camera looks at to the centre, and nothing behind it", () => {
    const m = cam([480, 270, -1000]);
    expect(projectWorld(m, comp, [480, 270, 0])).toEqual([480, 270]);
    expect(projectWorld(m, comp, [580, 270, 0])![0]).toBeCloseTo(580, 6); // zoom 1000 at distance 1000: 1 px per px
    expect(projectWorld(m, comp, [480, 270, -2000])).toBeNull();
  });

  it("a dolly in scales the patch by the distance ratio; a roll turns it", () => {
    const ref = cam([480, 270, -1000]);
    const near = cam([480, 270, -800]);
    const J = localAffine(ref, near, comp, [480, 270, 0])!;
    expect(J[0]).toBeCloseTo(1.25, 3);
    expect(J[3]).toBeCloseTo(1.25, 3);
    expect(Math.abs(J[1]) + Math.abs(J[2])).toBeLessThan(1e-6);
    const rolled = cam([480, 270, -1000], 10);
    const R = localAffine(ref, rolled, comp, [480, 270, 0])!;
    // The camera rolls 10 degrees, so the picture turns 10 degrees the other way.
    expect(Math.atan2(R[2], R[0]) * (180 / Math.PI)).toBeCloseTo(-10, 2);
    expect(Math.hypot(R[0], R[2])).toBeCloseTo(1, 4);
  });
});
