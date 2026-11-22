# Compositing calibration

`qa/calibrate-compositing.mjs` measures the compositing tools against answers After Effects itself knows. A real photograph is moved by keyframed Corner Pin or Transform values, darkened and tinted by solids at known opacities, covered by a known patch or object, or given a known grain. The tools never see those values; the harness compares what they report with them.

```bash
node qa/calibrate-compositing.mjs --plate <image or video> [--plate-time 4] [--dir <work dir>] [--only track,colour,grain,grain_curve,projection,inpaint]
```

Use real footage or a photograph with texture: synthetic noise flatters a tracker. On macOS the aerial screensaver clips in `/Library/Application Support/com.apple.idleassetsd/Customer` work (pick one with buildings or trees, not open water). The same isolation rules as `qa/smoke-mcp.mjs` apply. It writes `qa/out/calibration.json`, prints a table and never fails on a number.

## Results (AE 26.2.1, macOS, 960 x 540, 25 fps, 50 frames; a London aerial frame)

### Tracking (`ae_track_multi`, perspective, 8 auto points)

The true error is measured over the track's own quad, the 5 x 5 grid `expected_error_px` is judged on.

| Shot | True mean error | `expected_error_px` | True / expected | `rms_px` | Corner jitter (tool / true) |
|---|---|---|---|---|---|
| clean | 0.24 px | 0.34 | 0.71 | 0.12 | 0.51 / 0.52 |
| fast (3x motion) | 0.30 | 0.35 | 0.85 | 0.12 | 0.80 / 0.83 |
| defocus (blur 4) | 0.18 | 0.21 | 0.85 | 0.16 | 0.33 / 0.33 |
| grain (Noise 12%) | 0.27 | 0.35 | 0.77 | 0.12 | 0.66 / 0.67 |
| low contrast (35% + noise) | 0.12 | 0.14 | 0.87 | 0.12 | 0.20 / 0.19 |
| motion blur (3x, 180°) | 0.60 | 0.38 | 1.57 | 0.15 | 0.67 / 0.65 |
| parallax (a nearer surface) | 0.65 on the kept frames | 0.65 | 1.00 | 0.08 | 1.03 / 1.13 |

- `rms_px`, the fit residual, ran 3-5x below the true error and did not follow it (per-frame correlation near 0). That is why the tools now report `expected_error_px`: the point noise estimated from the residuals with the model's degrees of freedom, carried through the fit's covariance to the quad.
- Under motion blur all points shift together as the blur changes with the speed, which the residuals cannot see: the true error was 1.6x the estimate.
- Motion blur and the keys: a comp made by script has shutter phase 0, so a blurred frame shows the layer averaged over the quarter frame after its keys. The tracker follows the image, which is right; a check against the keys must use the keys a quarter frame later (the first run read 4 px of "error" that was this).
- Parallax: `sliding_points` named the two points on the nearer surface, and the five frames whose fit jumped 20-120 px (their `expected_error_px` 8x the track's median) were marked not ok, so `ae_track_apply` interpolates across them.
- Single points (`ae_track_point`) on the same shots: 0.2-0.4 px mean, 1.3 px on the fast shot (9 degrees of rotation without pattern warping), 0.65 px under motion blur.

### Colour (`ae_patch_color_match`, Levels)

A patch that is the plate itself, while the plate around it is darkened by a black solid (to 25%) and tinted by a warm Multiply solid (to 60%): the right patch colour at every frame is known exactly. Largest error after the fit, inside the patch: **0.2 levels of 255** (8.9 uncorrected).

### Grain (`ae_patch_grain`) and Add Grain itself

Add Grain on 50% gray, measured per pixel over 6 frames:

| Size | 0.25 | 0.5 | 0.75 | 1 | 1.5 | 2 |
|---|---|---|---|---|---|---|
| Neighbour correlation of the grain | 0.00 | 0.25 | 0.59 | 0.68 | 0.84 | 0.91 |
| Sigma at Intensity 0.3 (levels) | 2.58 | 1.67 | 1.01 | 0.77 | 1.13 | 1.48 |

Per-pixel noise matches Size 0.25; AE's default Size 1 is clumped. The old first guess (sigma / 20) started 7x too low at Size 1. `ae_patch_grain` now picks Size from the plate's grain coarseness (the neighbour correlation of a two-frame difference) and the first Intensity from the table for that Size. On a plate with Noise 10%: Size 0.253, patch correlation 0.001 against the plate's 0.000, sigma 0.94 of the plate's (0.86 with the old defaults, at correlation 0.77).

The table is from mid-gray; on a photograph the sigma per Intensity at Size 0.25 came out higher, so the tuning rounds still matter.

### 3D projection (`ae_scene_3d_report`, `ae_annotate_frame` with `include_3d`)

Eight 3D points and a rotated, scaled 3D layer, seen through a one-node camera (orientation and X/Y/Z rotation keyed) and a two-node camera (point of interest and rotations keyed), against where AE's own `toComp` puts them at four times. The maths used to apply X, Y and Z rotation in the wrong order: **up to 472 px off** (82 px mean) for the one-node camera, 65 px for the two-node one. Measured rule, now in `annotate.ts`: a layer's rotation is `Orientation(X . Y . Z) . Rotation(X . Y . Z)` with the usual right-hand matrices and all signs positive (Z acts first on a point); a two-node camera looks at its point of interest with +Y down, then the same rotations. Now 0.000 px for the points and under 0.006 px for the rotated layer; `server/test/projection-ae.test.ts` pins it with AE's numbers.

### Inpaint (`ae_inpaint_plate`)

A 100 x 100 hole over an 80 px object that crosses the frame; the truth is the plate without the object.

| Case | Mean error | PSNR |
|---|---|---|
| locked-off, temporal (`auto`) | 0.07 levels | 60 dB |
| moving camera, temporal along an `ae_track_multi` track | 0.6 levels | 47 dB |
| spatial only (no other frames) | 11.2 levels | 24 dB |
