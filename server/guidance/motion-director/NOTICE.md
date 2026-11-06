# Sources and licences

This skill is Chroma's own synthesis, written in its own words. It adapts ideas and numbers from
the sources below; where they disagreed, the choice made is noted in the text (mostly by the
"register" table in SKILL.md). No source text was copied verbatim. Researched 2026-11-05.

| Source | Licence | Used for |
|---|---|---|
| [lottiefiles/motion-design-skill](https://github.com/lottiefiles/motion-design-skill) | MIT, (c) 2025 LottieFiles | duration and easing tables, archetypes, springs, Disney principles with numbers, stagger budgets, the 1/3 rules, ambient loops, severity tiers, symptom fixes |
| [charlie947/motion-graphics-skills](https://github.com/charlie947/motion-graphics-skills) | MIT, (c) Charlie Hills | brand-first workflow, facts discipline, the 8 s move/hold/return loop, effect techniques, safe zones and hero sizes, banned defaults, one-change revisions, delivery specs |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes): hyperframes-animation, hyperframes-core, general-video, motion-graphics, and the later `skills/hyperframes/references` | Apache-2.0, (c) HeyGen | ease by role, motion budget, transitions as handoffs, velocity matching and recipes, beat grid, reading time, type floors, captions, audio levels, beat shares, pacing and staleness, review loop (measure then look, contact sheets, P0-P2 notes), the "looks generated" list |
| [Sunwood-ai-labs/hyperframes-motion-reel-skill](https://github.com/Sunwood-ai-labs/hyperframes-motion-reel-skill) | MIT, (c) 2026 Sunwood AI Labs | beat-grid-first timing, contrast of pace, text as image, motion-blur limits, state as a function of time |
| [geekjourneyx/hyperframes-motion-director](https://github.com/geekjourneyx/hyperframes-motion-director) | AGPL-3.0 | **ideas only, paraphrased, nothing copied**: brief then confirm, stills before motion, layout as rectangles, vertical title tiers, hook timing gates, primitives chosen by meaning, inspectable transition midpoints, rendered-frame evidence, learning rules from defects |

Caption note: an earlier draft of `references/sound-and-captions.md` followed the HyperFrames
captions references too closely. That section is now rewritten in Chroma's own words and kept to
motion points; the caption rules moved to the separate `captions` skill, whose `NOTICE.md`
credits the HyperFrames caption ideas (Apache-2.0, (c) HeyGen: Whisper failure modes, word
grouping by energy, clean-up of words over silence) along with the other sources.

Changes from the sources: rewritten for any toolchain with After Effects as the main target
(frame conversions, bezier to AE influence and speed, chroma-ae MCP tool mapping); conflicting
advice reconciled by register; web-, HTML- and GSAP-specific material removed.
