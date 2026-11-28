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

## Planar tracking on real footage (AE 27.0x78, Windows, 2026-11-27 and 2026-11-28)

Free Hollywood Camera Work VFX plates (1280 x 1080 DVCPRO HD, interpreted with square pixels; their licence allows using and publishing results but not hosting the clips, so they are not in the repository and a re-run needs a local copy).

**How it is judged.** A reference made the way a tracker works shares its blind spots: the laptop's first reference (the keyed screen's edge lines) flicked between the two edges of the screen's dark rim on the same frames as the edge tracker it was checking, so both agreed and a visible 1.5-2.5 px flicker scored as 0.2 px. So:

- the worst frame and the number of jumps are reported, not medians;
- an independent reference is used only where it is independent: SIFT matched straight to the reference frame on a textured surface, with whatever stands in front at the reference frame masked out;
- every result is also looked at: close-ups of the corners frame by frame, and each frame warped back onto the reference frame by the track and overlaid on it (the reference's detail in one colour, the frame's in another: a right track shows them as one);
- on a marked wall, the marks themselves: each mark's patch at the reference frame is matched in every frame warped back by the track, and its shift is the track's error there. A homography fitted to the matched marks (RANSAC) says whether the marks are on one plane at all. An overlay of the whole region scaled down to fit a screen hid drifts of 5-25 px on the marked walls below: they were first reported here as right.

Every track's corner paths also go through the tool's own path check (path-check.ts), which knows nothing of how they were made.

The thresholds were set on four tuning plates (the U-Haul truck, the licence plate, the laptop, the green board). Then they were left alone and the tool was run on clips it had never seen.

### Tuning plates

| Plate (frames) | What makes it hard | Method | Frames written | Against the independent reference (written frames) | Path check, written frames |
|---|---|---|---|---|---|
| U-Haul truck (189) | A person walks in front of half the truck | `region` | 189 | worst 0.9 px | no jump over 0.37 px |
| Licence plate (145) | Starts tiny, ends in a whip pan | `region` | 90; the tiny and whip-pan frames not ok; frame 101 (motion blur) not written on its expected error | worst 0.7 px | no jump over 0.38 px |
| Laptop green screen (219) | A double edge at the rim, a hand across the screen, the screen half out of frame at the end | `screen`, in AE | 218; frame 180 not written (path check) | no independent reference (see above) | corner noise 0.05 px, worst jump 0.4 px; AE's own render of the pinned insert stands still on frames 183-198, where the old tracker flicked |
| Green board with 6 markers (228) | A 4x zoom, an arm and a towel across it, a cyan top against its edge | `screen` | 128; 21 not written on their expected error, 4 on the path check | worst 6.5 px (frames 98-104, the corner both of whose sides the arm and the towel hide) | |

### Clips never used for tuning (run once, thresholds fixed)

Hollywood Camera Work's own pages say what each plate is for, and only some are planar tracking plates (the green cloud, the painting, the licence plate, the U-Haul and the laptop; the picture frame and markers-on-sticks plates were not downloaded). The marked walls (Matchmove Test Wide and Close, the window, Embassy, F15) are 3D matchmove plates: a patch of their wall is a fair planar test, but not what they were shot for. The glasses, the soda can, the sword and the head are object-tracking plates; the face is motion capture.

| Clip (frames) | Plate's purpose | Surface | What was found |
|---|---|---|---|
| Green cloud (195) | Planar tracking | A plain green board shaped like a cloud, held up and turned edge-on and back several times | `region` on the outline: right on every frame looked at (overlay, the whole outline lines up); 5 frames at the most edge-on not ok, rightly (1-3 px off). The first path check flagged 35 right frames, which led to its fast-turn rule (below) |
| Window set extension (210) | 2D, planar or matchmove (the page: planar is "not very good for this") | Marked green screen behind a window, candles and a tree in front, a push-in | Frames 61-67, a few px off, caught by the path check; frames 53-58 and 68-85 a few px off too and written (overlay of the 4 marks); 0-1 px before 50 and from 90 to 140 |
| MM test wide (215) | 3D matchmove | Marked studio wall, a person in front | **Wrong and not caught.** On the wall's 14 marks: 2 px off at frame 20, 6 at 40, 9 (worst marks 20) at 60, 25 at 100, while 10-13 of the marks fit one plane within 0.6-1.4 px. The region took in the curve of the cyc at the bottom; the surface check passed to frame 108 |
| MM test close (308) | 3D matchmove | Marked wall, a pole with flags passing in front | Frames 24-66 written 2-5 px off (marks), not caught: a few faint marks against a large textured occluder |
| Glasses (285) | 3D object tracking | One lens of a pair of glasses on a turning head | Right to frame 154; around frame 200 2-3 px off, not caught (the lens is curved, the head turns); 270-275 caught |
| Dolly without markers (172) | "Failed matchmove" | A plain, unevenly lit green screen | `region` refused: "the region is flat (almost no edges or texture to follow)" |
| Single marker (249) | 2D tracking, one marker, pan and tilt | A 22 x 42 px blue tape mark on wrinkled cloth | `ae_track_point` at its default 31 px pattern followed it at a confidence of 0.99 but slid up and down the mark by up to 3.5 px (its colour centroid as the reference; 0.5 px across). A pattern changing in one direction only is now grown until it holds: 51 px here, within 0.72 px on all 248 frames |

So on marked green walls with few marks the region track drifted by a few px to tens of px and its own checks did not see it.

### The surface's own points (surface-points.ts)

- **What it does.** At the reference frame up to 40 distinct points are picked inside the region: corners and marks, spread out, each holding against sliding. On every frame the region lined up, each one's reference patch is looked for in the frame warped back by the track (at half size within 40 px, then at full size within 3 px). Over 8 points, the ones one homography explains (RANSAC, 1.5 px) are kept, if they are at least half; with 4 to 7, every match must be strong. A frame where the kept points' median distance from the track is over 1.5 px (at 1080 lines) is not ok, with a note saying the region follows something off the surface's plane. Under 4 points there is no check, and the result says so.
- **Measured, with the region tracks of the clips above:**

  | Clip | Points | Before | With the check |
  |---|---|---|---|
  | U-Haul truck | 40 | 189 written, worst 0.9 px | 189 written: the points sat 0.1-0.4 px off on every frame |
  | Licence plate | 2 | 90 written | no check (too few points) |
  | Matchmove Test Wide | 14 | about 107 written, drifting to 29 px | 20 written; from frame 20 on not ok |
  | Window | 7 | 145 written, 53-58 and 68-85 a few px off | 101 written; 49-82 and the last frames not ok; 83-132, right in the overlay, written |
  | Matchmove Test Close | 15 | 64 written, up to 22 px off at the bottom left | 8 written |

- **A correction was tried and left out.** The points' homography applied to the track moved the truck's right corners by 1.2-5.8 px while the points themselves sat 0.1-0.4 px off: a person in front kept the points on part of the truck, and a fit to them, carried to the far corners, was worse than the region's own. The check turns a silent drift into frames that say why they are not written; it does not fix them. Draw the region on the one plane, or exclude what is not on it.
- **What it cannot do.** A surface with fewer than 4 distinct points (a plain screen, the licence plate, the glasses' lens) is not checked. Points on something passing in front are left out only when their match fails or they are outvoted; with a holdout matte, points under it are skipped.

The SIFT reference could not judge the three marked green walls: too few, too faint features (14 of 210 frames solved on the window). Matched on the person in front, it showed a wall moving that the overlay shows standing still.

### What the measurements changed

- **The edge-picking screen tracker is gone.** A screen is aligned as a region, in its brightness and its key together, with its rim and the inside edge of its frame. No edge is chosen per frame, so the two parallel edges of a dark rim cannot make a corner flick between them. The area is the corners grown by 4%, at least 6 px of image: a 2-3 px band round a small screen cut the edges' profile off at the coarse pyramid level and held the fit 1-3 px off.
- **What is in front of a key is found by colour** (region-track.ts OccluderDetector). A point of the key colour at the reference frame that shows no key colour now, at its place or one grid step to any side, has something in front. Pieces of 6 points or more, grown by 2, are left out of the fit, edges and all. On the laptop, a hand that had bent a corner 30 px in now leaves it within a pixel.
  - "No key colour" is a loose test: within the key's spread and at least 0.08 in chromaticity is key, and nothing is key from 0.06 beyond that. The key itself drifts over a shot (a green board turned to the sun moved 0.04-0.06), and the edge's tight key took two thirds of the board for something in front.
- **No colour detector on textured surfaces.** Two versions were tried and both did harm:
  - "Different from the reference here": once a motion went wrong, the board's marks landed off their places and were taken for something in front. The fit then kept the wrong place without the marks that could correct it.
  - "A colour the surface has nowhere": it left frames 16 px off that nothing caught.

  The fit's robust weights already handle a person in front of a textured surface.
- **The noise scale comes from samples on an edge only.** A flat sample's residual is always small. On a flat screen (half its samples flat) it made the scale so tight that an edge a pixel off was thrown out, and with it the only thing that could pull the fit back. A synthetic screen settled 1.8 px off; it is now 0.15 px.
- **No occlusion memory with a key detector.** The memory left out edge samples that had weighed little on the last frame (an anti-aliased edge always has some) and held a synthetic screen 0.5 px off; without it the error is 0.1 px.
- **On textured surfaces the memory stays.** A re-alignment from a finer level keeps the coarse levels' memory: left at "all visible", a person in front pulled the next frame 100 px off. Each frame is also tried once without the memory, because each alone lost a frame the other held.
- **A fit with fewer parameters only when the full fit lined up.** Tried whenever the full fit failed, a similarity found the board's markers matched onto other markers, 200 px off, and passed every check.
- **A frame whose expected error is 6x the shot's median** (and over 1 px, scaled from 1080 lines) is not written. It was 8x and 2 px. Wrong board frames ran at 10x (12-24 px off). Good frames of the laptop and the truck stayed within 3.2x, the plate's within 4x except its one motion-blurred frame.

### The path check (path-check.ts)

- **What it measures.** A camera shake moves, turns and scales the whole surface at once (the walking U-Haul's true corners jolt 20-26 px off a smooth path in one frame). The check takes that shared similarity out and looks at the surface's shape.
- **Two limits.**
  - A jump over 0.6 px: the frame against the quadratic through its two neighbours each side (it was half the second difference, the line through one each side, which put the peak of a board turning edge-on 2.7 px off). On the tuning plates' good tracks the worst was 0.46.
  - A distance off the robust fit through the 12 frames on each side over 2 px. The truck's true corners make a smooth 1.24 px bump there.

  Both limits rise to 6 times the shot's own noise when that is higher, and scale with the comp's height from 1080 lines.
- **Where the surface turns fast, off its path is not checked.** The green cloud, turned edge-on and back in the hand, went from 388 px wide to 203 and back to 376 within 24 frames, and the fit through 25 frames could not follow it: 35 frames of a right track (every one looked at) were up to 55 px off it, and not writing them would have left AE to draw a straight line across the turn. A wrong stretch and a real wobble look alike in a path. So where the shape's speed on either flank (the median step of the frames 3 to 12 away on one side) is over 2.5 px a frame, those frames are reported (`fast_turn_frames`) and only jumps are checked. Every frame the check had rightly flagged, on the tuning plates and the held-out clips, had flanks of 2.1 px a frame or less; the cloud's turns ran at 2.9-7.7. The flanks, not the frames next to it: the glasses' lens flipping 20-30 px for six frames made its own neighbourhood look fast, and two of its frames 24-32 px off went unflagged that way.
- **A jump is kept when leaving it out would be worse.** AE fills a frame that is not written with the line between its neighbours, which misses a surface speeding up or slowing down by its acceleration. A frame over the jump limit is not written only when it is further off the curve through its neighbours than that line would be (`jumps_kept` lists the others). On a steady surface the line is on the curve, so nothing changes there.
- **The checks against the clips.** With these three changes, the flags on the four tuning plates are the same frames as before; the glasses' and MM Close's caught stretches are all still caught; the window's frames 117-125, flagged before and right (overlay), are written; the cloud keeps flags on its last four frames (below) and on jumps of 0.7-1.9 px. One loss: MM Wide's frames 82-83, 97-98 and 105-106, 17-25 px off in a drift that went uncaught around them anyway, are no longer flagged, because its wrong track's shape moved fast.
- **What it cannot do.**
  - One edge moving by d shows as about 0.42 d, because taking the shared motion out takes part of it. So frames are flagged, not corners.
  - A wrong stretch longer than 12 frames, or one that drifts smoothly, can pass (MM Wide drifted 25 px in 100 frames).
  - A wrong stretch while the surface turns fast can pass.
  - At a track's first and last frames the fit is a line from one side, so the last frames of a surface still turning fast can be flagged although right (the cloud's last four). A quadratic there followed the green board's wrong first frames, which matter more.
  - The whole surface jumping cannot be told from a camera jolt by the path alone, so it is reported (`sharpest_move`), never flagged.

### Other measurements

- **The surface check** (region-track.ts): correlation 0.85 or more over 20% or more of the visible region, and a 6 x 6 grid of cells. At least 35% of the textured cells must agree, and the agreeing ones alone must hold the region's corners within 2 px (or twice the whole fit). On a screen only the key's correlation counts: over 60 frames of a right fit on the laptop, the key's held 0.98 while the brightness's fell from 0.78 to 0.66.
- **`expected_error_px` of a region track** (the fit's covariance times 12): true / expected had a median of 0.98 on the truck and 0.86 on the plate (textured). On mostly flat surfaces it is 2-2.5.
- **`ae_screen_corners`** on the laptop against the keyed reference: `auto` (the key edge) 0.49-0.61 px; `inner` 1.4-3.2 px; `outer` 11-18 px (the bezel's outer edge).
- **An insert of another aspect than the screen** (a 4:3 grid of circles on the laptop's screen, AE 27.0, 2026-11-28): every frame rendered by AE and warped back from the track's corners onto the insert comp, the circles came out round (axis ratio 1.000-1.002), 100 px as placed, centred within 0.1 px, with `fill` (the sides cropped) and with `fit` (bars).
- **Non-square pixels** (the same laptop plate interpreted as DVCPRO HD, pixel aspect 1.5, in a 1280 x 1080 comp of 1.5): AE rendered the comp's frames on its own pixel grid, matching the source to 0.001 px, and the screen track gave the same frames as in the square comp. Read in comp pixels, the screen's aspect came out 1.04 (the anamorphic squeeze); read as the picture shows it, 1.53. The square-pixel insert, pinned through a layer matrix narrowed by 1.5, warped back onto its comp: circles round to 1.002, centred within 0.7 insert px (0.2 comp px).
- **CC Power Pin**: with the reference motion written by `ae_screen_replace`, the rendered insert was within 0.99 px of the corners on all 37 sampled frames (a constant 1 px inward bias of the render). Expansion 2 landed within 0.85 px of expandQuad's corners.
- **Speed**: 180-500 ms of Node per frame for a region or screen track (1280 x 1080), on top of AE's render.
- **Mind the comp.** A pinned insert left on in the comp is rendered with the plate: a screen track run with the previous track's magenta insert on top followed its flicker. Track with `isolate_layers` on the plate.
