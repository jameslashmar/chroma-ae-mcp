# Tracking techniques: what the trackers do, and the research behind it

A sourced survey (2026-11-28) of how professional trackers (Mocha, Nuke, SynthEyes, PFTrack, 3DEqualizer, Silhouette, Fusion, After Effects, libmv) make 2D point and planar tracks accurate, done for `ae_track_multi` and `ae_track_point`. The survey follows this table unchanged; its section numbers are referred to here.

## Where the MCP stands

| Technique (survey section) | In the MCP | Measured |
|---|---|---|
| Reverse / backward tracking, outward from the best frame (1.1) | `ae_track_multi` tracks forwards and backwards from `ref_time`: put `ref_time` on the clean frame and `start` before it to track back. `ae_track_point`: an `end` before `start` tracks backwards. | (since 0.4) |
| Forward-backward error check (1.3, Kalal 2010) | `fb_check_px` (default 2 px at 1080 lines, at least 1 px) on every point of `ae_track_point` and the points method of `ae_track_multi`: each match is tracked back into the frame before, the way the forward step went; landing further away means a look-alike, and the point counts as lost there. | Single Marker: correct track (41 px pattern) round trip median 0.09, p95 0.21, max 0.66 px over 248 frames, no false alarm; the 31 px pattern that slides along the marker (up to 3.5 px) is caught at frame 10 (6.8 px). |
| High-pass / band-pass, local contrast normalisation (2.1-2.3) | `normalize_light` (radius at 1080 lines, off by default) on every method: the frame less its local mean, divided by its local contrast. | U-Haul with a synthetic 55% shadow band sweeping over the truck and a +-10% flicker: off, lost after 69 frames; a plain high-pass held 90; `normalize_light` 8 tracked all 189 at 0.19 px median against SIFT (clean plate: 189/189, 0.18 px, unchanged). |
| Channel choice (2.6) | `channel`: luma, red, green, blue, saturation. | (since 0.4) |
| Denoise before tracking (2.7) | `pre_blur` (box blur, points). | |
| Lighting gain / bias (2.3) | Per-channel gain and bias in the region and screen aligners. | |
| Pattern size against sliding (4.1) | `ae_track_point` grows a pattern that changes in one direction only (`pattern_isotropy`). | Single Marker: 31 px slid 3.5 px, 41 px held 0.8 px. |
| Tracking through occlusion, exclusion layers (4.6) | Occluders pushed out of the region fit; `region.exclude`; `holdout_layers`. | |
| Judging quality (4.8) | Path check (jumps, off-path stretches), the surface's own points against the homography, `expected_error_px`, preview sheets. | docs/CALIBRATION.md |
| Several reference frames (1.2: Nuke's keyframes, Mocha's reference frames, Silhouette's merge) | `ae_track_join`: track each stretch with a reference of its own, then join them on their shared frames (refused when they disagree; the base should be the track whose reference shows the surface largest). The surface's own points are judged in each frame's px. | Painting board, close-up to wide: one reference lost the close-up; two, joined, 0.40-0.72 px against the markers over all 228 frames. |
| Template update with drift correction, keyed bidirectional segments inside one call, coarse global search, lens undistortion, ESM (1.4, 4.2, 2.10, ranked list) | Not built yet. | |

---


Tags: **[doc]** official documentation, **[prac]** practitioner or forum source, **[paper]** academic paper, **[analysis]** my own derivation with no source behind it. Unconfirmed points are marked ⚑ and collected at the end.

**Source caveats:**
- Adobe helpx returned 403, so every After Effects quote comes from the CS4 manual mirror on manualsdir. The current AE tracker UI is the same, but the wording may differ.
- I could not fetch Blender's manual or the Fusion manual mirror (steakunderwater). Those points rest on search-result excerpts of those pages.

---

## 1. Reverse/backward tracking, bidirectional reconciliation, FB error, re-referencing

### 1.1 Start from the best frame and track outward (backward from a later frame)
- **Names and docs:**
  - Nuke: "Tracking backwards can produce a better track than going forwards if the pattern is clearly visible later in the clip." [doc] https://learn.foundry.com/nuke/content/comp_environment/tracking_stabilizing/automatic_tracking.html
  - Mocha: "scrub through the timeline and find the largest and clearest area to begin tracking from", then use the **Track Forwards and Backwards** button. [doc] https://borisfx.com/documentation/mocha/26.0.0
  - Nuke PlanarTracker: always start each pass from the same reference frame. If the plane is only partly visible for a stretch, track the fully visible section first. [doc] https://learn.foundry.com/nuke/content/comp_environment/planartracker/tracking_plane.html
  - SynthEyes planar: if you have changed direction repeatedly, finish with "a final tracking pass … that makes a single pass, or two with the main frame in the middle, to make all the tracking results consistent." [doc] https://borisfx.com/documentation/syntheyes/PlanarTrackingManual_files/tracking_forwards_or/
  - SynthEyes Quick Start: track backward when features approach from a distance. [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/quick_start_supervised/
- **Problem it solves:** the template should come from the frame with the most resolution and least blur or foreshortening. Error then grows outward from the best-conditioned frame.
- **Hurts when:** the reference frame is chosen per pass and differs between passes. SynthEyes says that retracking a frame in the opposite direction gives a different result and "neither is specifically right" (same URL as above).
- **Verify:** compare the worst-frame corner error against an independent reference for each candidate reference frame. [analysis]

### 1.2 Keyframe / bidirectional tracking and how the passes are reconciled
- **Nuke Tracker keyframe tracking:** "compares the current pattern anchor to the patterns of the two nearest keyframes." More keyframes give a better track at the cost of time. When tracking fails, "Tracker attempts to continue using the next keyframe as a reference." For noisy areas, seed several tracks and "average the resulting tracks together". [doc] https://learn.foundry.com/nuke/content/comp_environment/tracking_stabilizing/keyframe_tracking.html ⚑ The exact blend between the two keyframe matches is not documented.
- **SynthEyes:**
  - The reference is "the closest keyed frame behind the current frame, considering the tracker's tracking direction". With keys at 20 and 30, the reference is 20 going forward and 30 going backward. [doc] (tracking_forwards_or URL above)
  - **Key Every N** places keys automatically. Auto keys "are adjusted manually to prevent drifting."
  - **Key Smooth N**: when you set a key, the preceding N frames "need to be re-tracked", which smooths the path into the new key. **Pre-roll by Key Smooth** backs up and retracks those frames automatically. [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/staying_on_track_and/
- **SynthEyes Fine-Tune (two-pass refinement):** rewrites each tracker to "only one key every 8 frames (by default)", then runs the supervised tracker on the frames in between with very small search sizes, "a few pixels". Key Spacing = 1 retracks at the higher tracking resolution. [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/fine_tuning_the_trackers/ and https://borisfx.com/documentation/syntheyes/syntheyesum_files/types_of_trackers/
- **PFTrack Polish:** re-tracks "the point forwards and backwards over a small range of frames". The new positions "will be blended with the previous tracking positions according to distance from the current frame". Used to smooth jumps after manual repositioning; it does not overwrite manual keys. [doc] https://pftrack.thepixelfarm.co.uk/documentation/pftrack_node_user_track.html
- **Silhouette:** "track forwards from the first frame to the last, and then create a second track … tracking backwards from the last frame to the first. These two trackers are then averaged together to derive a more accurate track." **Merge** joins trackers with different frame ranges and compensates offsets, ideally with at least one overlapping keyframe. [doc] https://borisfx.com/documentation/silhouette-2026.0/Silhouette-2026/Nodes-Tracker.html
- **Mocha AdjustTrack** (drift correction after tracking; details in §3).
- **Mechanism to build** [analysis]:
  - For keys A < B, run a forward track from A and a backward track from B.
  - Blend the corner positions (not homography matrix entries) with w(t) = (t−A)/(B−A). Better still, weight each pass by its inverse residual or FB error.
  - Plain averaging, as Silhouette does, leaves a step at both ends. A distance ramp, as PFTrack does, pins each end to its own key.
- **Hurts when:** one pass has locked onto the wrong texture. Averaging then halves the error instead of rejecting the bad pass, so gate the blend on per-pass residual or FB error. [analysis]
- **Verify:** the jump at key boundaries should vanish. The worst frame mid-segment should drop compared with either single pass.

### 1.3 Forward-backward (FB) error as a quality check
- **Source:** Kalal, Mikolajczyk and Matas, "Forward-Backward Error: Automatic Detection of Tracking Failures", ICPR 2010. [paper] https://dspace.cvut.cz/handle/10467/9553
- **Mechanism:**
  - Track a point forward k frames, then track the result backward to the start.
  - FB error = ‖x_t − x̂_t‖₂, the distance between the start point and the backward-tracked estimate.
  - The paper presents it as complementary to NCC.
  - Their Median Flow tracker discards the worst 50% of points and takes the median displacement. ⚑ The 50% figure comes from a secondary source: https://arxiv.org/pdf/2502.16569. OpenCV's implementation pairs an NCC window (`winSizeNCC`) with an FB criterion: https://docs.opencv.org/4.x/d6/dd1/structcv_1_1legacy_1_1TrackerMedianFlow_1_1Params.html
- **Applied to a homography tracker** [analysis]:
  - For each frame t, compute H(t→t+1), then H(t+1→t). Measure the maximum corner displacement of H_back·H_fwd against the identity.
  - Or run it over a whole segment: track A→B, then B→A.
  - Cost is 2× tracking.
- **What it catches:** lock-on to a wrong but similar texture where the residual or NCC still looks good.
- **Hurts when:** both directions fail the same way, for example on symmetric or repetitive texture, or when an occluder moves with the plane. FB error is necessary for a good track, not sufficient.
- **Verify:** check that FB error peaks line up with the frames flagged against an independent reference.

### 1.4 Re-referencing ("update reference") policies, and drift vs. lock-on
| Tool | Options (exact names) | Source |
|---|---|---|
| AE | **Adapt Feature On Every Frame**: the search uses the previous frame's feature region instead of the original. **If Confidence Is Below → Adapt Feature**: "use the original tracked feature until the confidence level falls below the specified threshold". Other actions: Continue / Stop / Extrapolate Motion. Pick a threshold "slightly larger than the largest confidence value for the problematic frames." Process Before Match is unavailable while Adapt Every Frame is on. | [doc] https://www.manualsdir.com/manuals/753846/adobe-after-effects-cs4.html?page=276 |
| Nuke Tracker | **pattern grab behavior**: every n frames (default 0), when error > (0.05), when error <, when tracking is stopped, when tracker is moved. **max_error** 0.2 stops the search. **epsilon/resolution** 0.01. **max iterations** 100. | [doc] https://learn.foundry.com/nuke/content/reference_guide/transform_nodes/tracker.html |
| Fusion | **Adaptive Mode**: None (always the original pattern) / Every Frame ("compensate for gradual changes in profile and lighting", but it "may start tracking the shadow") / **Best Match** (does not reacquire when the difference from the original pattern exceeds **Match Tolerance**) | [doc, search excerpt] https://www.steakunderwater.com/VFXPedia/__man/Fusion18-6/Fusion18_Manual_files/part669.htm |
| PFTrack | **Window update**: Starting Frame (default) / Every Frame / Above Threshold (with **Window threshold**). **Failure threshold** ends tracking. | [doc] PFTrack URL in §1.2 |
| Silhouette | **Behavior**: Start Frame vs Every Frame. Every Frame "will cause inherent drift" but handles drastic perspective or scale change. | [doc] Silhouette URL in §1.2 |
| Blender/libmv | **Match**: Keyframe (default) vs Previous frame. Keyframe matching prevents sliding but "can lead to small jumps" and failures. Previous-frame matching handles large transforms "but can lead to sliding". | [doc] https://www.docs.blender.org/api/3.1/bpy.types.MovieTrackingSettings.html and the 3.0 manual (search excerpt) https://docs.blender.org/manual/en/3.0/movie_clip/tracking/clip/toolbar/track.html |
| 3DEqualizer | "automatic keyframing based on tracking deviation" | [doc] https://3dequalizer.com/?item=tech_spec&site=start |
| Mocha Point Tracker (in SynthEyes) | **Reduce Drift**: "periodic drift compensation" ⚑ mechanism undocumented | [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/mocha_point_tracker |

- **The principled fix: drift-corrected template update** (Matthews, Ishikawa and Baker, "The Template Update Problem", BMVC 2003 / PAMI 2004). [paper] https://bmva-archive.org.uk/bmvc/2003/papers/143/paper143.pdf
  1. Track with the current template T_n to get p_n.
  2. Starting from p_n, align the **first** template T_1 to get p*_n.
  3. If ‖p*_n − p_n‖ < ε, update T_{n+1} = I_n(W(x; p*_n)). Otherwise keep T_n, which is the conservative choice.
  - The paper notes that the drift-correction step can use gradient magnitudes for illumination robustness.
- **Trade-off** [analysis]:
  - A fixed reference keeps error bounded but fails once appearance changes (perspective, scale, lighting).
  - A previous-frame reference accumulates error: roughly √N for unbiased per-step error and linearly for biased error.
  - Threshold re-grab policies (Nuke, AE, PFTrack, Fusion) and keyed references (Nuke, SynthEyes) sit between the two. Matthews S3 gets near-fixed-reference accuracy with an adaptive template.

---

## 2. Pre-processing before tracking

### 2.1 High-pass filtering
- **Names:**
  - SynthEyes **Hi-Pass** (Filtering/Rez tab of the image preprocessor). [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/filtering_tab/
  - Mocha Preprocessing **High Pass** ("pulls fine details … enhanced further by using contrast"). [doc] Mocha 26 guide (URL in §1.1)
  - Nukepedia **HighPassing** gizmo, "to help 2D tracking". [prac] https://www.nukepedia.com/tools/gizmos/filter/highpassing/
  - Building one by hand: blur and subtract. [prac] https://beforesandafters.com/2020/12/07/a-quick-tutorial-on-digital-painting-and-spatial-frequencies/
- **Problem:** "Pattern match trackers can be thrown off by scenes with rapid overall illumination changes, especially explosions and strobe lighting." [doc] https://borisfx.com/documentation/syntheyes/syntheyesum_files/types_of_trackers/
- **Mechanism and parameters:**
  - SynthEyes builds the high-pass from a Gaussian blur of the given radius, applied before down-sampling.
  - The radius is "generally much larger than a 2-pixel blur to compensate for grain, say around 10 pixels".
  - The result is "a fairly monotonous gray". Restore contrast with the Color levels, e.g. "low=0.25, high=0.75". [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/handling_strobes_and/
  - Math [analysis]: HP(I) = I − G_σ∗I (+0.5 offset for display). It removes additive offset and any illumination component smoother than σ (gradients, vignetting, shadow ramps, flicker shading). It does **not** remove multiplicative gain, so keep the gain term or follow with contrast normalization (§2.3). Your per-channel gain/bias model is global, so it cannot model a spatial gradient; HP can.
- **Hurts:**
  - "The larger the value, the more the original image will 'show through'", and processing gets slower.
  - It removes much of the image, "so there is less information to track". SynthEyes says to set planar trackers to **High** detail mode when it is on. [doc] https://borisfx.com/documentation/syntheyes/planartrackingmanual_files/lighting_compensation/
  - Over-done, it looks like "a very badly Xeroxed copy" and stops helping. [prac] https://www.provideocoalition.com/high-pass-script/
  - [analysis] It shrinks LK's convergence basin, because coarse-scale gradients are gone. Scale σ per pyramid level, or apply it only at the finer levels.
- **Verify:** compare the residual and worst-frame error on flicker or strobe segments with HP on and off. Check that it does not regress on clean segments (Mocha: "We recommend trying to track the shot before attempting preprocessing").

### 2.2 Band-pass / difference-of-Gaussians
- SynthEyes documents the combination directly: "use a small blur for grain/compression in conjunction with the high-pass". This is a DoG (G_σ1 − G_σ2 with σ1 ≈ 1–2 px and σ2 ≈ 10 px). It "will also reduce any slight banding" from the levels expansion. [doc] handling_strobes_and URL in §2.1
- Mocha's equivalent is **Blur** plus **High Pass** in its Preprocessing panel. [doc]

### 2.3 Contrast normalization, luminance compensation, photometric invariance
- **Nuke pre-track filter**, "applied before image patches are compared":
  - **none**.
  - **adjust contrast**: "stretches the image contrast to better suit the tracking algorithm"; recommended.
  - **median**: "helps to remove noise from the pattern".
  - [doc] https://learn.foundry.com/nuke/8.0/content/user_guide/tracking_stabilizing/tracking_preferences.html
  - ⚑ The 8.0 guide calls adjust contrast the default; the current reference table lists median.
- **Nuke adjust for luminance changes:** "extra pre-filtering to compensate for changes in brightness". It slows tracking and "can reduce the accuracy", so enable it only for known brightness changes. Paradoxically it "can occasionally produce better tracks" on jittery shots with no luminance change. [doc] (same URL) ⚑ Algorithm undocumented.
- **Nuke clamp super-white, sub-zero footage** (default on) clamps patches to 0–1. To use the full dynamic range, disable it and raise max_error, e.g. pixel values of 40 → max_error around 40. [doc] (same URL)
- **libmv/Blender Normalize:** "normalize the image patches by their mean before doing the sum of squared error". Gain invariance only, and slower. [doc] https://projects.blender.org/blender/blender/raw/branch/main/intern/libmv/libmv/tracking/track_region.h
- **SynthEyes planar lighting "Uniform":** adapts to lighting-level changes, but it "adds a substantial amount of CPU time" and can break tracks that would otherwise work. [doc] lighting_compensation URL in §2.1
- **3DE pattern mode:** "robust against rapid changes of brightness and/or contrast". [doc] 3DE tech spec URL in §1.4 ⚑ Method undocumented.
- **Mocha Remove Flicker:** "Balances flickering footage". It needs **Set Reference Frame**, which defines "the Reference frame to take the luminance levels to adjust to". In effect it matches each frame's global luminance to the reference. [doc] Mocha 26 guide
- **Research alternative:** ECC (Evangelidis and Psarakis, PAMI 2008), an alignment objective invariant to photometric distortion. It also has a projective version. [paper] https://www.academia.edu/5287415/Parametric_Image_Alignment_Using_Enhanced_Correlation_Coefficient_Maximization
- ⚑ **Local contrast normalization** ((I − local mean) / local std) is not documented in any of the tools. Nuke's "adjust contrast" is a stretch whose locality is undocumented.

### 2.4 AE Process Before Match
- **Blur:** "Usually a value of 2 to 3 pixels is enough to produce better tracks in grainy or noisy footage."
- **Enhance:** "exaggerates or refines the edges of an image and makes them easier to track".
- It applies only to tracking. Older docs say it is unavailable with Adapt Feature On Every Frame and tie it to the older tracker plug-in.
- [doc] https://www.manualsdir.com/manuals/753846/adobe-after-effects-cs4.html?page=276
- ⚑ What Enhance computes (unsharp mask? edge filter?) is undocumented. A Creative COW user reported it was not enough and moved to levels/contrast before tracking. [prac] https://creativecow.net/?p=139170

### 2.5 Gamma / levels / luminance boost
- Available in Mocha (**Contrast** for low-contrast images, **Gamma**) [doc], 3DE ("gamma controls", "brightness, contrast", "blur/sharpen") [doc], and SynthEyes (Color levels) [doc].
- ⚑ Tracking scene-linear plates in a log or display transform is common practice but undocumented. [analysis] In linear EXR, shadow gradients are compressed, so a log or gamma pre-transform raises the gradient signal there. Track data is geometric, so you track the prepped plate and apply the result to the original.

### 2.6 Channel selection rules
- **AE:** RGB if the feature is a distinct color; Luminance if it differs in brightness; Saturation if it "has a high concentration of color". [doc] p.275/276 of the CS4 manual
- **Mocha Input Channel:** Luminance ("contrast in the light and dark"); **Auto Channel** ("contrast in one of the color channels"); R/G/B. [doc]
- **Fusion:** automatically selects the channel "based on an analysis of each channel for contrast, clarity, and reliability". The Resolve manual says to choose the "cleanest, highest contrast channel" and avoid grainy ones. [doc, search excerpt] https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part2034.htm
- **SynthEyes:** "use RGB in most circumstances until proven otherwise". Use a single channel "when one channel has very high noise". [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/channel_selection/
- **PFTrack:** disable noisy channels. [doc]
- ⚑ "Avoid blue, it is the noisiest" is common lore; I found no primary source for it.
- [analysis] Fusion-style auto choice for your tracker: score each channel by the structure-tensor min-eigenvalue divided by an estimated noise variance.

### 2.7 Degrain / denoise
- **Mocha Smoothing Level:** "blurs the input clip before it is tracked … useful when there is a lot of severe noise". Default 0. Mocha also has **Denoise** in Preprocessing. [doc]
- **SynthEyes:**
  - Blur is applied before down-sampling.
  - **Noise Reduce** values of 1–5 are typical. It is "for helping tracking, not producing finished images" and is designed to avoid operations that shift feature positions. "Unclear if this is more helpful than a similar small Blur value."
  - [doc] filtering_tab URL in §2.1 and https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/minimizing_grain/
- **Nuke:** median pre-filter. **PFTrack:** Blur. [doc]
- **libmv `sigma`:** "the size in pixels of the blur kernel used to both smooth the image and take the image derivative". [doc] libmv header URL in §2.3 ⚑ Its default is not confirmed; 0.9 appears in a binding test.
- **Practice:** denoise, track the denoised plate, apply the track to the original [prac] https://g13405184.myblog.arts.ac.uk/2020/11/30/denoise-track-and-stabilize/. Denoise in log for fewer artifacts [prac] https://www.nukepedia.com/knowledge/general-tutorials/written-tutorials/non-destructive-clean-up-work-using-difference/
- **Hurts:** loses fine detail. SynthEyes says fine patterns such as text need High detail. [doc] https://borisfx.com/documentation/syntheyes/planartrackingmanual_files/selecting_the_detail/

### 2.8 Sharpening
- Mocha **Sharpen** is "useful when there is low detail". AE Enhance is the other documented option. [doc]
- [analysis] Sharpening amplifies grain, which LK's gradients see directly. Use it only after denoise.

### 2.9 Deinterlacing
- **AE Track Fields:** "Temporarily doubles the frame rate … and interpolates each field to a full frame to track." [doc] CS4 manual p.276
- **Mocha:** set field separation (Upper/Lower) when creating the project. Their guidance: "try to avoid interlaced footage where possible". [doc] https://support.borisfx.com/hc/en-us/articles/11064314508173-How-do-you-use-Mocha-with-interlaced-footage-in-Mocha-Pro-Standalone

### 2.10 Lens-distortion removal before planar tracking
- **Fusion:** "the more lens distortion in the footage, the more the resulting track will slide and wobble". [doc, search excerpt] https://www.steakunderwater.com/VFXPedia/__man/Fusion18-6/Fusion18_Manual_files/part1136.htm
- **Mocha Lens module:** the calibration "can be applied to undistort the footage, assist the tracker OR to be applied to the tracked insert". Mocha "is quite robust and more often than not users get great results without applying any lens calibration." [prac, Ross Shain, Imagineer] https://creativecow.net/?p=187366
- **SynthEyes:** set cropping and distortion "before beginning tracking". [doc] https://borisfx.com/documentation/syntheyes/syntheyesum_files/image_preprocessor_dialog/
- [analysis] A homography is exact only on an undistorted (pinhole) image. Residual distortion shows up as corner wobble that grows toward the frame edge. It also produces false disagreement in your independent-feature check.

### 2.11 Stabilized or proxy plates; tracking-prep precomp
- **Pre-stabilizing:** "I would suggest not pre-stabilizing your footage before any mocha work". [prac, Ross Shain] (Creative COW URL in §2.10)
- **Stabilize as a check:** "always generate a stabilized plate or region then match move it back … That way you can check how good your track is." [prac, Navid Bagherzadeh] https://borisfx.com/news/why-i-love-mocha-pro-navid-bagherzadeh-compositor/
- **Proxy / resolution:** SynthEyes tracks autotracked spots only at nominal resolution and supervised trackers at a higher one. It recommends Fine-Tune at Key Spacing 1 to re-run at the higher resolution, which implies a coarse pass followed by a full-res refinement. [doc] types_of_trackers URL in §2.1 ⚑ No source quantifies the accuracy loss from proxy tracking.
- **Prep is non-destructive in the tools themselves:** Mocha Preprocessing ("non-destructive clip processing"), AE Process Before Match (tracking-only), and the SynthEyes preprocessor (images modified "before they are cached … for tracking"). [doc]

---

## 3. Mocha parameters (Mocha 2026 User Guide, https://borisfx.com/documentation/mocha/26.0.0, unless noted)

- **Input Channel:** Luminance / Auto Channel / Red / Green / Blue (§2.6). ⚑ How Auto chooses its channel is undocumented.
- **Min % Pixels Used:**
  - "By default, the minimum percentage of pixels used is dynamic."
  - "In many cases, the cause of a drifting or slipping track is a low percentage of pixels."
  - Raising it gives "a more solid and accurate track" but is slower.
  - "If you draw a very large shape, the percentage will be low."
  - Tip title: "When in doubt, ramp up your pixels."
  - The SynthEyes-hosted Mocha Point Tracker adds that higher Pixels % is more accurate but slower "and more sensitive to occlusion", and that Auto picks the percentage "based on patch size and image content". [doc] Mocha Point Tracker URL in §1.4
  - A practitioner comparison used 70%. [prac] https://vimeo.com/42964064
  - ⚑ Which pixels are selected (gradient-ranked? random?) is undocumented. [analysis] The behavior suggests a pixel budget capped in absolute terms, so a large shape gets a low percentage.
- **Smoothing Level:** blur before tracking; default 0; for severe noise. ⚑ Kernel and units undocumented.
- **Motion:**
  - Translation / Scale / Rotation / Shear / Perspective. Shear covers skew; Perspective covers out-of-plane rotation.
  - A practitioner test shows shear-only slipping on a 3D-rotated plane where perspective held. [prac] Vimeo URL above
  - The Mocha Point Tracker defaults to and recommends 2D TRSA (affine). [doc]
- **Large Motion / Small Motion / Manual Tracking:**
  - Large: "searches for motion and optimizes the track as it goes" (default).
  - Small: "only optimizes", for "very subtle changes"; it also runs inside Large.
  - Manual: for fully obscured or untrackable stretches.
  - **Search Area:** Horizontal/Vertical (Auto by default), **Angle** for fast rotation, **Zoom %** for fast zoom.
  - [analysis] Large ≈ a global search for initialization followed by gradient refinement; Small ≈ refinement only.
- **Track individual fields:** set by project field separation (§2.9).
- **AdjustTrack** ("primarily used for eradicating drift"; "not practical to use it to remove jitter"):
  - **Transform AdjustTrack:**
    - Point count sets the correction model: 1 = translation, 2 = scale/rotation, 3 = shear, 4 = perspective.
    - **Set Reference Frame** defines the comparison frame. Zoom windows show the reference vs the current frame.
    - A point "only affects the track within the bounds of its own keyframes". By default, keyframing a point also keyframes the others.
    - **Auto** "tries to guess where the point needs to be"; **Auto Nudge** steps through the shot at a frame interval, with search fields. Neither is recommended as a finishing solution.
  - **Classic:**
    - Four reference points on the primary frame. "Moving a Primary Reference Point will NOT change the tracking data."
    - At the worst-drift frame, move the point back to its primary-frame position.
    - Auto: "a tracker will attempt to line up the selected Reference Point based on its position in the Primary Reference frame."
    - "If you see a Reference Point drifting, that will indicate the track is drifting."
  - **Workflow:** adjust at the peak of the drift, then check halfway between. Many keys mean you should retrack.
  - ⚑ How corrections are interpolated between keyframes is undocumented.
- **Surface vs layer shape:**
  - The spline defines the pixels that are tracked. "The Surface and Grid have no keyframes; they are simply guides that let you check the accuracy of your track."
  - Tips: "include the edges"; "keep the shape not tight on the edge".
- **Exclusion layers:** "the mattes of any active layers above the layer itself are subtracted from the matte of the layer". Keep tracking layers at the top of the stack. Create "an exclusion zone" for obstructions and reflections.
- **Preprocessing panel:** Blur, Sharpen, Contrast, Gamma, High Pass, Denoise, Remove Flicker (+ Set Reference Frame), Apply to All. ⚑ No numeric ranges are documented.

---

## 4. Other accuracy practices

### 4.1 Pattern and search size
- **AE:** the feature region goes "tightly around its tracked feature". The search region covers "only the frame-to-frame movement", larger for abrupt changes. [doc] https://www.manualsdir.com/manuals/753846/adobe-after-effects-cs4.html?page=272
- **Silhouette:** search = the maximum per-frame movement; larger regions are slower. [doc]
- **PFTrack:** the pattern must contain enough pixels "to uniquely locate" the point. Too large a search causes jumps to similar-looking points. [doc]
- **SynthEyes planar:**
  - "if the search size is too small, sporadic bumps … will often cause loss of track".
  - Raise the rotation and scaling rate search parameters for spins and crash zooms.
  - [doc] https://borisfx.com/documentation/syntheyes/planartrackingmanual_files/troubleshooting/
- **SynthEyes spot trackers:** too big a tracker picks up the surroundings; too small and it jumps between local maxima. [doc]
- **Trackability:** Shi and Tomasi, "Good Features to Track" (CVPR 1994). The criterion is the min eigenvalue of the gradient matrix, and they monitor dissimilarity against the **first** frame with an affine model. [paper] https://users.cs.duke.edu/~tomasi/papers/shi/shiCvpr94.pdf ⚑ I checked the criterion only through secondary summaries.

### 4.2 Motion prediction / search initialization
- **SynthEyes prediction modes:**
  - **Steady**: predicts from the last several frames.
  - **Hand-Held: Sticky**: searches at the previous position and needs a larger search.
  - **Hand-Held: Use others**: uses already-tracked trackers to predict.
  - **Re-track at existing**.
  - [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/prediction_modes_and/
  - For planar trackers, the prediction mode sets the initial search size. [doc] https://borisfx.com/documentation/syntheyes/PlanarTrackingManual_files/shot_prediction_mode/
- **libmv `use_brute_initialization`:** a brute-force translation-only search before the full search. `attempt_refine_before_brute` tries refinement first and falls back to brute search. [doc] libmv header URL in §2.3
- **Other tools:** AE Extrapolate Motion; PFTrack Predict, which needs camera metadata. [doc]

### 4.3 Subpixel accuracy
- **Tool settings:** AE Subpixel Positioning [doc]; Nuke epsilon 0.01 [doc].
- **Parabolic peak bias:** a 3-point parabola fit on SSD/NCC peaks causes "pixel-locking", a bias toward integer positions (Shimizu and Okutomi, ICCV 2001). [paper] https://scispace.com/papers/precise-sub-pixel-estimation-on-area-based-matching-2e6fty9vrx
- **Fixes:**
  - LK refinement with affine window adaptation (Stein et al., ICRA 2006). [paper] https://www.ri.cmu.edu/publications/attenuating-stereo-pixel-locking-via-affine-window-adaptation
  - Symmetric refinement (Nehab et al.). [paper] https://pixl.cs.princeton.edu/pubs/Nehab_2005_ISS/subpixel.pdf
  - **Directly relevant to your NCC point tracker.**
- **Drift-free intrinsic-center modes:**
  - 3DE Marker mode ("sub pixel precise center of mass") and Corner mode. [doc]
  - SynthEyes spot and symmetry trackers, which "can be tracked easily through the shot without drift" on suitable features. [doc]

### 4.4 Choosing reference frames
See §1.1: the largest and clearest frame (Mocha), a later clear frame tracked backward (Nuke), or the main frame in the middle (SynthEyes).

### 4.5 Offset tracking when a feature leaves frame or is covered
- **Nuke:** Ctrl/Cmd-drag the anchor to a nearby point. This works "providing that the distance between the two points remains constant", and the Tracker joins the tracks. [doc] automatic_tracking URL in §1.1
- **PFTrack:** X/Y offset. **Silhouette:** offset the track point. **AE:** Attach Point Offset. [doc]
- **Planar:** track any co-planar region. The surface is separate from the tracked shape (Mocha docs above).

### 4.6 Tracking through occlusion
- **Mocha:** exclusion layers / layer order (§3).
- **Fusion:** with the Hybrid tracker a mask "is strongly recommended"; with the Point tracker, try without one. [doc, search excerpt] https://www.steakunderwater.com/VFXPedia/__man/Fusion18-6/Fusion18_Manual_files/part653.htm. Per a practitioner, Point mode discards points that move differently from the rest. [prac] https://mixinglight.com/color-grading-tutorials/planar-tracking-101-davinci-resolve-fusion
- **Nuke:** falls back to the next keyframe as reference.
- **PFTrack:** hide the tracker, then key it again when the feature returns.
- **SynthEyes:** mask obscuring objects.
- **libmv:** `image1_mask` pattern mask.
- **Silhouette:** Point Track ML handles occlusion and off-screen motion (no mechanism given).
- [doc] for each of the above.

### 4.7 Motion-blur-aware tracking
- No commercial documentation describes blur-aware matching ⚑. The Mocha Point Tracker docs only list motion blur as a use case.
- **Research:** Jin, Favaro and Cipolla, CVPR 2005. Instead of deblurring frames, they **blur the template** with estimated blur vectors, so the cost depends only on deformation plus two blur vectors. [paper] https://research.adobe.com/publication/visual-tracking-in-the-presence-of-motion-blur/
- [analysis] In your tracker: convolve the reference with a line kernel along the predicted per-frame corner motion × shutter fraction before matching.

### 4.8 Judging quality
- **Error readouts:**
  - Nuke per-keyframe error, colored green to red; "a red keyframe doesn't necessarily mean that the tracking result is poor".
  - PFTrack Tracking Errors graph in pixels, 0.0 at a matching score of 1.0.
  - 3DE deviation curves and "on-the-fly 2D tracking outlier analysis".
  - AE Confidence.
  - [doc]
- **SynthEyes Clean Up Trackers:**
  - Bad frames are flagged when the error exceeds an hpix threshold or falls in the worst N%.
  - Example "high-error" rule: more than 30% bad frames or more than 2 hpix average.
  - Running it on a bad solve "may delete trackers that are good".
  - [doc] https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/clean_up_trackers_dialog/ and https://borisfx.com/documentation/syntheyes/SynthEyesUM_files/high_error_trackers/
  - **Deglitch** replaces a spike with the average of the prior and following positions. [doc] https://borisfx.com/documentation/syntheyes/syntheyesum_files/deglitch_mode/
- **Visual checks:**
  - Nuke PlanarTracker "display grid". The **Stabilize CornerPin** is "most useful for drift corrections and making sure your tracking results are reliable". [doc] tracking_plane URL in §1.1
  - Fusion: "Does it stick to the surface? Switching to Steady mode can help". [doc, search excerpt] Fusion part1136 URL in §2.10
  - Mocha surface and grid as guides; a drifting AdjustTrack reference point means drift. [doc]
  - Stabilize, then match-move back. [prac] Navid Bagherzadeh URL in §2.11
- **Feature-consistency filters:** Nuke PlanarTracker Track Threshold, Track Smoothness ("removes tracks that glitch") and Track Consistency. [doc] https://learn.foundry.com/nuke/8.0/content/user_guide/planartracker/adjusting_tracking_results.html
- ⚑ I found no primary source for a checkerboard insert as a check.

### 4.9 Smoothing, and when not to
- **Tools:**
  - Nuke smoothT/R/S average N frames (default 0). [doc]
  - Nuke PlanarTracker jitter smoothing (0–1) targets "low-amplitude jitter, usually introduced by noisy images"; heavy settings "may produce unexpected results". [doc]
  - Silhouette Smooth slider. [doc]
- **Cautions:**
  - SynthEyes: filtering "causes sliding, so use it only when necessary". Filter the Distance channel to reduce chatter toward and away from the plane. [doc] https://borisfx.com/documentation/syntheyes/planartrackingmanual_files/glitch_fixing/
  - Mocha: AdjustTrack is not for jitter. [doc]
- [analysis] Smooth only when the jitter is tracker noise, i.e. the image residual does not rise after smoothing. Inserts locked to real camera shake must not be smoothed.

---

## Ranked: the 8–10 most promising additions for your homography IC-LK tracker

1. **Drift-corrected template update (Matthews S3) or multi-keyframe references (Nuke's two nearest keys, SynthEyes' nearest key behind).** A single reference frame either stops matching once appearance changes or drifts if chained. S3 keeps near-fixed-reference accuracy and adapts only when the check against the original template agrees.
2. **Keyed bidirectional segments with distance- or residual-weighted crossfade (PFTrack Polish, Silhouette average, SynthEyes Key Smooth).** Pins both ends of each segment to a verified key, so error peaks mid-segment instead of growing to the shot ends. Gate each pass on its FB error or residual so a bad pass is rejected, not averaged in.
3. **Per-frame forward-backward error in corner pixels (Kalal 2010), used to place keys automatically (3DE "keyframing based on tracking deviation").** Catches lock-on to a wrong but similar texture that residual, NCC and your path-jump check miss. It is also a reference-free metric you can log for each held-out clip.
4. **Coarse global search before LK (libmv brute translation, Mocha Large Motion), plus motion prediction from velocity or from other tracked features (SynthEyes "Use others").** The pyramid LK convergence basin is the usual failure point on whip pans and blur. You already track independent features, so "use others" costs almost nothing.
5. **Optional high-pass / DoG pre-filter (σ ≈ 10 px high-pass plus σ ≈ 1–2 px low-pass, applied per pyramid level), with Mocha-style global flicker matching to the reference.** Per-channel gain/bias cannot model spatially varying light such as gradients, sweeping shadows or strobes, and HP removes them. Gate it per shot, since it costs texture.
6. **Lens undistort before fitting the homography (Fusion, Mocha Lens, SynthEyes).** Distortion makes the homography model wrong, and Fusion documents the result as "slide and wobble". It also causes false alarms in your independent-feature check near the frame edges.
7. **Post-alignment ZNCC gate and pixel-coverage check (libmv `minimum_correlation` / INSUFFICIENT_PATTERN_AREA, Mocha Min % Pixels, Nuke re-grab "if error above").** Gives explicit failure states that trigger re-key, Manual or holdout handling. Mocha names a low pixel percentage as the common cause of drift.
8. **Staged motion model with regularization (translation → similarity → affine → homography; libmv `regularization_coefficient`; SynthEyes Medium detail = Low then High).** Stops the perspective terms absorbing noise on low-texture or near-fronto planes, which removes the corner jitter that shows up in your worst-frame metric.
9. **Fine-tune pass at full resolution: keys every ~8 frames and a tiny search (SynthEyes Fine-Tune).** Run it after a robust first pass to cut jitter without reintroducing drift.
10. **ESM instead of IC-LK, or LK on gradient/HOG feature channels (Benhimane & Malis 2004; Antonakos et al. 2015).** ESM gets second-order convergence from first-order derivatives, giving fewer lost frames on large inter-frame homographies. Feature channels add illumination robustness. This is research-grade and lower priority.
    - Sources: https://www.campar.in.tum.de/pub/benhimane2004iros1/benhimane2004iros1.pdf and https://eprints.nottingham.ac.uk/31444
- **Bonus for the NCC point tracker:** replace the parabolic peak fit with LK subpixel refinement to remove pixel-locking bias (Stein 2006). Add a center-of-mass or symmetry mode for markers, which is drift-free (3DE, SynthEyes).

## Not confirmed (⚑)
- What AE Enhance computes.
- Mocha internals: how pixels are chosen for Min % Pixels Used, the Smoothing Level kernel and units, Auto Channel logic, AdjustTrack interpolation between keys, whether Mocha references the previous frame or a fixed reference, and the Mocha Point Tracker's "Reduce Drift".
- Nuke internals: the adjust-for-luminance-changes method, the pre-track filter default (adjust contrast in the 8.0 guide vs median in the current table), and how keyframe matches are blended.
- Fusion: the Match Tolerance default, and all Fusion text, which I saw only as search excerpts.
- Blender/libmv: the default values of libmv `sigma` and Blender's Correlation Min.
- Kalal: I did not read the full paper; the Median Flow 50% figure is from a secondary source.
- Common practice with no primary source found: blue-channel-noise lore, tracking in log vs linear, the checkerboard-insert check, and the accuracy loss from proxy tracking.
- 3DE internals beyond its tech-spec bullet points.
