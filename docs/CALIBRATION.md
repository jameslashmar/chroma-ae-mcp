# Compositing calibration

`qa/calibrate-compositing.mjs` measures the compositing tools against answers After Effects itself knows. A real photograph is moved by keyframed Corner Pin or Transform values, darkened and tinted by solids at known opacities, covered by a known patch or object, or given a known grain. The tools never see those values; the harness compares what they report with them.

```bash
node qa/calibrate-compositing.mjs --plate <image or video> [--plate-time 4] [--dir <work dir>] [--only track,colour,grain,grain_curve,projection,solve,slip,element,light,matte,painted,clone,lens,inpaint]
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

The response to Intensity is a straight line (Size 0.25: sigma 0.90, 1.73, 2.58, 3.85, 5.13, 6.85 at Intensity 0.1, 0.2, 0.3, 0.45, 0.6, 0.8; Size 0.5 about 5.5 per unit; Size 1 about 2.5 per unit above 0.2), but Add Grain puts more grain in the shadows: at Size 0.25 and Intensity 0.3, gray 0.25 gave 3.86, gray 0.5 2.58 and gray 0.75 1.32, a straight line in the gray level (factor 1 + 1.98 (0.5 - gray)). The first Intensity now allows for the area's mean gray, so on the photograph it starts at 0.37 (0.66 without the tone factor) and needs at most one round; the default tolerance is now 5%.

On this test plate the tool's robust temporal sigma (from the frame difference's median absolute deviation) reads the plate's AE Noise at 0.82 of the per-pixel standard deviation: the effect's noise is not Gaussian. So by the per-pixel measure the patch ends at 0.89 of the plate (0.81 with the old 10% tolerance). Film grain is closer to Gaussian, where the two measures agree; a check on real grain is still to do.

### 3D projection (`ae_scene_3d_report`, `ae_annotate_frame` with `include_3d`)

Eight 3D points and a rotated, scaled 3D layer, seen through a one-node camera (orientation and X/Y/Z rotation keyed) and a two-node camera (point of interest and rotations keyed), against where AE's own `toComp` puts them at four times. The maths used to apply X, Y and Z rotation in the wrong order: **up to 472 px off** (82 px mean) for the one-node camera, 65 px for the two-node one. Measured rule, now in `annotate.ts`: a layer's rotation is `Orientation(X . Y . Z) . Rotation(X . Y . Z)` with the usual right-hand matrices and all signs positive (Z acts first on a point); a two-node camera looks at its point of interest with +Y down, then the same rotations. Now 0.000 px for the points and under 0.006 px for the rotated layer; `server/test/projection-ae.test.ts` pins it with AE's numbers.

### Camera solve check (`ae_camera_solve_check`)

The plate as a 3D plane under a camera that dollies 18%, pans and tilts; eight nulls on the plane (features) and one 250 px in front of it. The check through the true camera should read only the tracker's noise; through a copy with 3% more zoom and 8 px of offset, the slide that camera really has against the picture (from the projection maths above, at the frames the tool measured).

| Camera | Nulls on the plane: largest error, tool | The same, true | Verdict |
|---|---|---|---|
| true | 0.04-0.28 px | 0 | mostly sticks; the off-plane null slides (lost) |
| 3% zoom, 8 px off | 1.5-4.0 px | 2.1-4.9 px | slides |

A fixed first-frame pattern read 1-3 px on the perfect solve (the dolly scales the picture 22%), and chaining the pattern frame to frame added up the matching noise (up to 1.5 px); the tool warps the first frame's pattern by how the camera turns and scales a small patch facing it (the projection's local affine), which gives the numbers above. Points within half a pattern of the frame edge stop being measured there.

### Slip of a pinned insert (`ae_patch_check` with `region_track`)

An insert (a different texture, masked to a 200 x 160 rect) pinned with exactly the plate's Corner Pin, and one whose pins drift 3 px to the right over the shot; `region_track` is the plate's Corner Pin.

| Insert | Slip read, 0.4 / 0.8 / 1.2 / 1.6 / 1.96 s | True |
|---|---|---|
| locked | 0.05 / 0.04 / 0.06 / 0.05 / 0.13 px | 0 |
| drifting | 0.63 / 1.19 / 1.74 / 2.46 / 2.88 px | 0.61 / 1.22 / 1.84 / 2.45 / 3.00 |

Before, the slip measure ignored the track: it followed features with no prediction and modelled the ring's motion as a similarity. It read 0.7 px of slip a frame apart (the plate's perspective), lost most features across 10 frames of motion, and reported 9-29 px of slip on the locked insert. Now, with a region track, each feature is looked for where the track puts it with its pattern warped by the track's local affine, and the slip is the patch features' offset from the track minus the ring's. `ae_track_apply` returns a ready `verify_with` call for this check.

### Element colour match (`ae_color_match_element`)

The element is the photo shifted 300 px and masked, with a known mismatch: red output white 0.85, green gamma 1.3, blue output black 0.06. Three 16 px pairs (dark, mid, bright) are picked where the element shows what the plate shows 300 px to the left.

| | Whole element area against the plate | Fitted |
|---|---|---|
| before | 11.8 levels mean absolute difference | |
| after | 0.34 levels | red input white 0.850 (truth 0.85), green gamma 0.787 (1/1.3 = 0.769), blue input black 0.062 (0.06) |

AE's Levels gamma lifts the mids above 1 (out = in^(1/gamma)), as the tool assumes. With three pairs and five Levels values the fit is underdetermined: a free five-value fit found exact but odd answers (blue gamma 1.3 with output white 0.63), so the tool fits two three-value families (output side, input side) and keeps the better, or the one that changes least.

### Light tracking on an element (`ae_patch_color_match` on any layer)

The colour shot's light change (the plate darkened by a black solid to 25% and tinted by a warm Multiply solid to 60% over the shot), with an element of other content on top (the photo at 60% and shifted, masked to 220 x 180): run on the element, the colour match makes it follow the plate's light. Its colour at every checked frame was its colour at 0 times the shot's gain within **0.19 levels** (15.1 levels uncorrected). The fit works on ratios against `ref_time`, so the element's own content does not matter; light direction and shadows are not matched.

### Matte check (`ae_matte_check`)

A known matte: an ellipse with a 6 px mask feather, two holes cut in it (Subtract masks), three 5 px specks and a 160 x 80 solid at 10% (a veil); a second copy whose mask expansion jumps 3 px in and out every frame.

| | Holes | Garbage | Veil | Edge chatter | Soft edge |
|---|---|---|---|---|---|
| truth | 2 | 3 | 12,800 px | none / every frame | 6 px feather |
| steady | 2 | 3 | 12,812 px | 0 | 9.4 px |
| chattering | 2 | 3 | 12,812 px | 0.33 of edge pixels | 9.4 px |

The soft edge is measured where alpha is between 0.05 and 0.95: a 6 px feather gives 9.4 px of it. The temporary copy was removed every time.

### Painted still reload (`ae_cleanplate_setup` action `reload`, `painted_check`)

A still patch is made (the tool keeps a hidden copy of the PNG as rendered, `.chroma-original-<name>`), then the PNG is saved over four ways and reloaded:

| Saved | `painted_check` |
|---|---|
| paint in the hole only | ok; the changed area [410, 210, 510, 290] is exactly the painted rect |
| red +6 everywhere (a colour profile) | check; colour shift 6, 0, 0 levels |
| the whole picture moved 3 px | check; offset 3, 0 px |
| cropped to 940 px wide | check; 940 x 540 against 960 x 540 |

### Offset clone under rotation and zoom (`ae_cleanplate_setup` source `clone_offset` with a track)

The plate turns 0.4 degrees, zooms 0.5% and pans per frame; a clone 150 px and 8 frames away should show at the hole the photo 150 px over (the truth comp moves that shifted photo the same way). The clone used to be moved by the region centre's shift only, which is exact for a spatial offset under a similarity but not across frames of a turning or zooming shot: here it would have been 5.4-6.0 px off at the hole's corner. It is now a Corner Pin on the plate copy, `H(t) . T(-offset) . H(t+k)^-1` carried into the copy's layer space, and the hole matched the truth within **0.27-0.62 levels** (resampling) at 0, 0.4, 0.8 and 1.2 s. The offset is in comp pixels as the shot looks at `ref_time`.

### Lens distortion warning (`lens` in the track summaries)

The clean pin shot and the same shot through AE's Optics Compensation (field of view 40 and 80) after the pin, tracked with 8 points over the whole frame. A one-parameter radial model about the frame centre is fitted to the fit's inliers; the plate counts as distorted when the model lowers the residual by a quarter and 0.1 px or more and moves a corner over 5 px.

| Shot | Residual without -> with the lens model | k | Corner moved | Verdict |
|---|---|---|---|---|
| straight | 0.179 -> 0.179 px | (flat) | | straight |
| field of view 40 | 0.607 -> 0.419 px | -0.064 | 35 px | distorted |
| field of view 80 | 0.909 -> 0.365 px | -0.297 | 163 px | distorted |

Fitting all points, outliers included, read 7 px of residual on the straight shot; the inliers only fix that. Tracks whose points stay in the middle of the frame (none reach half the half-diagonal) get no verdict: 57 earlier calibration tracks, none flagged.

### Inpaint (`ae_inpaint_plate`)

A 100 x 100 hole over an 80 px object that crosses the frame; the truth is the plate without the object.

| Case | Mean error | PSNR |
|---|---|---|
| locked-off, temporal (`auto`) | 0.07 levels | 60 dB |
| moving camera, temporal along an `ae_track_multi` track | 0.6 levels | 47 dB |
| spatial only (no other frames) | 11.2 levels | 24 dB |

## Results on Windows (AE 26.2.1, 2026-11-22)

Emre's Windows PC. The plate is a textured photograph of a rock surface (a scanned rock, the Windows wallpapers are smooth renders), not the Mac's London aerial, so tracking numbers are not like for like. The run took 15.5 minutes; `--only grain,grain_curve` was run again after `b3a9b2a`.

- **Projection:** one-node and two-node cameras, mean 0 px, max 0.001 px over 32 points (macOS 0.000).
- **Add Grain curve:** the same as macOS to two decimals, so no per-platform `ADD_GRAIN_CURVE` or tone factor is needed. At Intensity 0.3 and gray 0.5, Size 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 gave sigma 2.576 / 1.667 / 1.01 / 0.773 / 1.125 / 1.483 and neighbour correlation 0.001 / 0.254 / 0.585 / 0.681 / 0.841 / 0.907. Size 0.25 at Intensity 0.1 / 0.2 / 0.45 / 0.6 / 0.8 gave 0.896 / 1.729 / 3.853 / 5.134 / 6.846. Gray 0.25 / 0.5 / 0.75 at Size 0.25, Intensity 0.3 gave 3.862 / 2.576 / 1.32.
- **`ae_patch_grain`** (AE Noise on the photograph): Size 0.253 measured; first Intensity 0.666 before `b3a9b2a` and 0.527 after (the tone factor); final Intensity 0.559; the patch ends at 0.865 of the plate by the per-pixel measure.
- **Tracking** (true mean error / `expected_error_px`, px): clean 0.066 / 0.072, fast 0.116 / 0.082, defocus 0.056 / 0.035, grain 0.115 / 0.134, low contrast 0.074 / 0.064, motion blur 0.539 / 0.153 (3.5x; macOS 1.6x), parallax 0.197 / 0.188 with one sliding point and no frame flagged. All 49 of 49 frames solved.
- **Colour** (`ae_patch_color_match`): worst residual 1.27 levels (33.0 uncorrected); light tracking 1.19 (34.0). macOS: 0.2 (8.9) and 0.19 (15.1). On a second, brighter plate: 1.78 (90.5) and 1.49 (84.1). The residual is 2-4% of the uncorrected error on both platforms, so it follows the plate (8-bit rounding of a darkened bright plate is the likely part). Running one plate on both platforms would settle it.
- **Solve check:** true camera, plane nulls 0.07-0.17 px (macOS 0.04-0.28); off camera, tool 2.46-4.03 against true 3.14-4.95 px.
- **Slip:** locked insert max 0.061 px; drifting 0.62 / 1.24 / 1.83 / 2.48 / 3.02 against true 0.61 / 1.22 / 1.84 / 2.45 / 3.00.
- **Element colour match:** 18.6 to 0.19 levels; red input white 0.852 (truth 0.85), green gamma 0.758 (0.769), blue input black 0.061 (0.06).
- **Matte:** holes 2, garbage 3, veil 12,812 px (12,800), soft edge 9.37 px for a 6 px feather, chatter 0 steady and 0.326 chattering. Same as macOS.
- **Painted check:** the four cases as on macOS.
- **Clone offset:** the hole is 0.56-1.37 levels from the truth; a shift-only clone would be 5.4-6.0 px off.
- **Lens:** straight 0.052 to 0.052 px; field of view 40: k -0.074, corner 40.5 px, 0.232 to 0.045 px; field of view 80: k -0.268, corner 147.8 px, 0.754 to 0.378 px. Verdicts as on macOS.
- **Inpaint:** static temporal 0.00 levels (99 dB), moving temporal 0.40 (50.1 dB), spatial only 3.48 (34.3 dB).
